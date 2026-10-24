import base64
import time

import httpx

RETRY_STATUS = {408, 429, 500, 502, 503, 504}


class OpenRouterError(RuntimeError):
    pass


def extract_file_annotations(response):
    """File annotations from a success or error response, deduped by file.hash."""
    if not isinstance(response, dict):
        return []
    choices = response.get("choices") or [{}]
    from_message = (choices[0].get("message") or {}).get("annotations") or []
    from_error = ((response.get("error") or {}).get("metadata") or {}).get("file_annotations") or []
    seen, out = set(), []
    for a in [*from_message, *from_error]:
        h = isinstance(a, dict) and a.get("type") == "file" and (a.get("file") or {}).get("hash")
        if isinstance(h, str) and h not in seen:
            seen.add(h)
            out.append(a)
    return out


def _cost(resp):
    return (resp.get("usage") or {}).get("cost", 0) or 0


def _usage(resp):
    u = resp.get("usage") or {}
    return {"prompt": u.get("prompt_tokens", 0), "completion": u.get("completion_tokens", 0),
            "reasoning": (u.get("completion_tokens_details") or {}).get("reasoning_tokens", 0)}


class OpenRouter:
    def __init__(self, api_key, base_url="https://openrouter.ai/api/v1", ocr_model="google/gemini-2.5-flash-lite",
                 transport=None, sleep=time.sleep, retries=5):
        self.ocr_model = ocr_model
        self.sleep = sleep
        self.retries = retries
        self.http = httpx.Client(base_url=base_url, timeout=300, transport=transport,
                                 headers={"Authorization": f"Bearer {api_key}"})

    def _post(self, body, on_retry=None):
        """POST with backoff on rate limits, 5xx and network errors. OpenRouter can also report errors inside
        a 200 body. A response that failed after the PDF was parsed still carries the annotations, so keep it."""
        for attempt in range(self.retries):
            last = attempt == self.retries - 1
            try:
                r = self.http.post("/chat/completions", json=body)
            except httpx.TransportError as e:
                if last:
                    raise
                if on_retry:
                    on_retry(f"{type(e).__name__}, retry {attempt + 1}")
                self.sleep(2 ** attempt)
                continue
            try:
                data = r.json()
            except ValueError:
                data = {}
            error = data.get("error") or {}
            status = r.status_code if r.status_code != 200 or "choices" in data else int(error.get("code") or 502)
            if status == 200 or extract_file_annotations(data):
                return data
            if status in RETRY_STATUS and not last:
                if on_retry:
                    on_retry(f"HTTP {status}, retry {attempt + 1}")
                self.sleep(2 ** attempt)
                continue
            raise OpenRouterError(f"HTTP {status}: {error.get('message') or r.text[:300]}")

    def ocr_pdf(self, pdf_bytes, name, engine="mistral-ocr", on_retry=None):
        """Parse a PDF with OpenRouter's file-parser plugin; returns the parsed text parts."""
        data_url = "data:application/pdf;base64," + base64.b64encode(pdf_bytes).decode()
        resp = self._post({
            "model": self.ocr_model,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "Reply with the single word: ok"},
                {"type": "file", "file": {"filename": name, "file_data": data_url}}]}],
            "max_tokens": 5,
            "plugins": [{"id": "file-parser", "pdf": {"engine": engine}}],
        }, on_retry)
        texts = [p["text"] for a in extract_file_annotations(resp)
                 for p in a["file"]["content"] if p.get("type") == "text"]
        if not texts:
            raise OpenRouterError("no parsed text in the response")
        return {"texts": texts, "cost": _cost(resp), "usage": _usage(resp)}

    def vision(self, png_bytes, prompt, model, reasoning=None, on_retry=None):
        """Image + prompt -> text. Reasoning models can burn every token thinking and return null content;
        retry once with reasoning off, and fail loudly rather than return (and cache) nothing."""
        url = "data:image/png;base64," + base64.b64encode(png_bytes).decode()
        body = {"model": model, "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt}, {"type": "image_url", "image_url": {"url": url}}]}]}
        cost = 0
        for effort in (reasoning, {"enabled": False}):
            if effort:
                body["reasoning"] = effort
            resp = self._post(body, on_retry)
            cost += _cost(resp)
            text = (resp["choices"][0]["message"].get("content") or "").strip()
            if not text and on_retry:
                on_retry("empty content (reasoning used every token)")
            if text:
                return {"text": text, "cost": cost, "usage": _usage(resp)}
        raise OpenRouterError(f"{model} returned empty content")
