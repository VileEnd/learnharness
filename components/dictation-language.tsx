"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { DICTATION_LANGUAGES } from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";
import { SettingsMenuTrigger, SettingsRow } from "@/components/settings/controls";
import { SearchMenuList } from "@/components/settings/search-menu-list";
import { useDictationActive } from "@/components/dictation-state";
import { useDictationLanguage, type DictationChoice } from "@/components/dictation-preference";

type LanguagePreference = ReturnType<typeof useDictationLanguage>;

/** "Default" sends no `language` param, so Deepgram's own default applies. */
const DEFAULT_OPTION = { code: "default" as DictationChoice, label: "Default (Deepgram)" };
const OPTIONS: readonly { code: DictationChoice; label: string }[] = [DEFAULT_OPTION, ...DICTATION_LANGUAGES];

/** Per-user dictation language (General settings). It is not a model, so the
 *  allowed-models policy never touches it. */
export function DictationLanguageSetting() {
	const preference = useDictationLanguage();
	const active = useDictationActive();
	return <SettingsRow label="Language" testid="row-dictation-language" dimmed={active}>
		<DictationLanguagePicker preference={preference} disabled={active} />
	</SettingsRow>;
}

function DictationLanguagePicker({ preference, disabled }: {
	preference: LanguagePreference;
	disabled: boolean;
}) {
	const { choice, saving, error, load, save } = preference;
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const label = OPTIONS.find((item) => item.code === choice)?.label ?? "—";

	useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element;
			if (target instanceof Element && target.closest('[data-testid="dictation-language-menu"]')) return;
			if (!triggerRef.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open]);
	const closeOnEscape = (event: ReactKeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		setOpen(false);
		triggerRef.current?.focus();
	};
	const pick = async (code: DictationChoice) => {
		if (disabled || saving || choice === undefined) return;
		if (await save(code)) {
			setOpen(false);
			triggerRef.current?.focus();
		}
	};

	return <>
		<Hint label={error ?? `Dictation language: ${label}`} side="top">
			<SettingsMenuTrigger
				ref={triggerRef}
				value={label}
				data-testid="dictation-language"
				aria-label={`Dictation language: ${label}`}
				aria-expanded={open && !disabled}
				disabled={disabled || saving}
				onKeyDown={(event) => { if (open) closeOnEscape(event); }}
				onClick={() => {
					setOpen((value) => !value);
					if (choice === undefined) void load().catch(() => {});
				}}
				className="min-w-20 max-w-[65%]"
			/>
		</Hint>
		{open && !disabled && <MenuShell
			anchorRef={triggerRef}
			testid="dictation-language-menu"
			preferredSide="down"
			menuClass="flex w-72 max-w-[calc(100vw-1rem)] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
		>
			<div onKeyDown={(event) => {
				closeOnEscape(event);
				if (event.key === "Enter") {
					// Empty search results must not submit the composer, but a
					// focused option button still needs Enter's native click.
					if (event.target instanceof HTMLInputElement) event.preventDefault();
					event.stopPropagation();
				}
			}}>
				{error && <div role="alert" className="mb-1.5 text-destructive">{error}</div>}
				<SearchMenuList
					items={OPTIONS}
					itemKey={(item) => item.code}
					searchTerms={(item) => [item.code, item.label]}
					isSelected={(item) => item.code === choice}
					onPick={(item) => { void pick(item.code); }}
					disabled={saving || choice === undefined}
					searchTestid="dictation-language-search"
					listTestid="dictation-language-list"
					optionTestid={(item) => `dictation-language-${item.code}`}
					ariaLabel="Search dictation languages"
					placeholder="Search languages…"
					empty="No languages match."
					renderItem={(item) => <span className="text-card-foreground">{item.label}</span>}
				/>
			</div>
		</MenuShell>}
	</>;
}
