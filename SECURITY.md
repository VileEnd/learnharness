# Security policy

LearnHarness stores API keys, chats and learning records on the server you run it on, and its agent fetches web content and reads documents on your behalf. The app has no authentication of its own: it is meant to run behind a login proxy (see [`docs/self-hosting.md`](docs/self-hosting.md)). If you find a way to abuse any of that, please tell us privately so a fix can ship before the details are public.

## Reporting a vulnerability

**Do not open a public issue or pull request for a security problem.**

Report it through GitHub's private vulnerability reporting for this repository (`VileEnd/learnharness`): open the **Security** tab and choose **Report a vulnerability**.

A useful report includes:

- the LearnHarness version and how you deploy it;
- what an attacker can do and what they need first (a web page the agent reads, a document the learner imports, a login, network access, and so on);
- steps to reproduce, or a proof of concept;
- any fix or mitigation you have in mind.

## What to expect

Reports are handled on a best-effort basis, with no fixed timeline. The fix is developed privately in a GitHub security advisory.

## Supported versions

Only the latest release receives security fixes. If you run from source, update to the latest `main` or the latest release tag.

## Scope

In scope:

- the web app and its API routes, as deployed by the documented stack;
- the agent and its tools, including prompt injection from web pages, PDFs or other content that leads to reading, changing or sending your data;
- rendered content such as demos, figures and markdown.

Out of scope:

- attacks that already require running code on the server or in your account;
- a deployment that publishes the app container's port directly, without the login proxy;
- bugs in third-party model or service providers themselves (report those to the provider);
- automated scanner output without a demonstrated impact on LearnHarness.
