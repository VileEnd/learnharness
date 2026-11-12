"use client";

import { Button } from "@/components/ui/button";
import {
  ButtonGroup,
  ButtonGroupText,
} from "@/components/ui/button-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactElement } from "react";
import type { LhViewMessage } from "@/src/core";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import remarkBreaks from "remark-breaks";
import {
  defaultRehypePlugins,
  Streamdown,
  type PluginConfig,
  type StreamdownProps,
} from "streamdown";
import { mdComponents } from "@/components/md-blocks";
import { repairMathForDisplay, transformMathDelimiters } from "@/src/core";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: LhViewMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};

interface MessageBranchContextType {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(
  null
);

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error(
      "MessageBranch components must be used within MessageBranch"
    );
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch);
      onBranchChange?.(newBranch);
    },
    [onBranchChange]
  );

  const goToPrevious = useCallback(() => {
    const newBranch =
      currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const goToNext = useCallback(() => {
    const newBranch =
      currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length,
    }),
    [branches, currentBranch, goToNext, goToPrevious]
  );

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div
        className={cn("grid w-full gap-2 [&>div]:pb-0", className)}
        {...props}
      />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({
  children,
  ...props
}: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = useMemo(
    () => (Array.isArray(children) ? children : [children]),
    [children]
  );

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden"
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>;

export const MessageBranchSelector = ({
  className,
  ...props
}: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className={cn(
        "[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md",
        className
      )}
      orientation="horizontal"
      {...props}
    />
  );
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({
  children,
  ...props
}: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({
  children,
  ...props
}: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({
  className,
  ...props
}: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn(
        "border-none bg-transparent text-muted-foreground shadow-none",
        className
      )}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
};

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

// Type-only version skew: @streamdown/code bundles shiki@3 types while
// streamdown@2.5 expects shiki@4 types. Both work at runtime (each ships its
// own highlighter); the cast papers over the .d.ts mismatch.
//
// Standard dollar authoring (owner, 2026-10-12): $...$ inline, $$ fenced
// on separate lines for display. transformMathDelimiters stays as the
// compatibility reader for old \(...\)/\[...\] content; its two-dollar
// output remains valid alongside native single-dollar math.
//
// remark-breaks rides in the cjk plugin's remarkPluginsAfter slot (public
// PluginConfig API): Streamdown's bare `remarkPlugins` PROP would REPLACE the
// defaults ([remark-gfm, codeMeta]), silently dropping GFM and code-fence
// metastring parsing. The slot appends after the defaults, which is the
// standard remark-gfm → remark-breaks order.
//
// MERMAID is app-owned since the chrome-melt wave (2026-09-19): the md-blocks
// `code` override intercepts mermaid fences and renders via
// components/mermaid-render.ts — streamdown's internal mermaid machinery
// (the plugin entry + the `mermaid` prop) is retired with it.
export const streamdownPlugins = {
  cjk: {
    ...cjk,
    remarkPluginsAfter: [...cjk.remarkPluginsAfter, remarkBreaks],
  },
  code,
  math: createMathPlugin({ singleDollarTextMath: true }),
} as unknown as PluginConfig;

// Remend's incomplete-HTML heuristic mistakes `<b` in `$a<b$` for a
// partial tag and deletes the remaining source before math can tokenize.
// Preserve that text (unfinished prose HTML may show literally); Streamdown's
// separate sanitization/hardening and all other Markdown repairs stay enabled.
export const streamdownRemend = { htmlTags: false };

// Model output and imported documents must not load remote images: a rendered
// ![x](https://host/?d=...) sends data out with no click. Streamdown's
// default harden step allows every image prefix, so this keeps its
// raw → sanitize → harden pipeline and sets allowedImagePrefixes to [], which
// blocks every <img> that markdown can produce, with four deliberate changes:
//   - before harden, an image to another site (http(s) or protocol-relative)
//     becomes a link (its alt text, else its address) that the learner can
//     open: Streamdown's link button asks before it navigates. Inside an
//     existing link it becomes plain text instead, never a nested link;
//   - data: raster images (png, jpeg, gif, webp) display: they make no
//     network request. The sanitize step is told to keep a data: src, and
//     harden's own allowDataImages switch (already on in Streamdown's default
//     options) lets it through; other data: types (svg, html, ...) are dropped
//     here;
//   - a kept data: image is reduced to src, alt, title, width and height and
//     rendered as a bare <img> (md-blocks `img`), not in Streamdown's block
//     wrapper, which is a <div> and cannot sit inside a <p> or a link;
//   - relative and same-origin addresses stay blocked: an <img> pointed at
//     one of the app's own GET routes would call it.
// The app's own images (figures, drawings, photos, page images) are separate
// <img> elements that do not render through markdown. The plugins are named
// explicitly, in the order needed, so a Streamdown upgrade that reorders or
// adds a default cannot change the pipeline unnoticed (a test pins the
// default's shape).
type HastNode = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

const RASTER_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp)[;,]/;
const KEPT_IMAGE_ATTRIBUTES = ["src", "alt", "title", "width", "height"];
const REMOTE_IMAGE = /^(?:https?:)?\/\/[^/\s]/i;

function imageToLink(root: HastNode): void {
  const walk = (node: HastNode, inLink: boolean) => {
    node.children = node.children?.flatMap((child): HastNode[] => {
      if (child.type !== "element") return [child];
      // A <source srcset> inside <picture> would load a remote image for a
      // data: <img> next to it; <picture> adds nothing without it.
      if (child.tagName === "source") return [];
      if (child.tagName === "picture") {
        walk(child, inLink);
        return child.children ?? [];
      }
      if (child.tagName !== "img") {
        walk(child, inLink || child.tagName === "a");
        return [child];
      }
      const src = String(child.properties?.src ?? "");
      if (src.startsWith("data:")) {
        // Harden's own switch would also pass data:image/svg+xml.
        // A kept image carries only these attributes: id, name, usemap and the
        // like could clobber document globals (name="body") or reach out
        // (srcset, longdesc).
        const kept: Record<string, unknown> = {};
        for (const key of KEPT_IMAGE_ATTRIBUTES) if (child.properties?.[key] !== undefined) kept[key] = child.properties[key];
        child.properties = RASTER_DATA_IMAGE.test(src) ? kept : { ...kept, src: "" };
        return [child];
      }
      if (!REMOTE_IMAGE.test(src)) return [child];
      const href = src.startsWith("//") ? `https:${src}` : src;
      const alt = String(child.properties?.alt ?? "").trim();
      const text = { type: "text", value: alt || href } as HastNode;
      return [inLink ? text : { type: "element", tagName: "a", properties: { href }, children: [text] }];
    });
  };
  walk(root, false);
}

const { raw, sanitize, harden } = defaultRehypePlugins as Record<"raw" | "sanitize" | "harden", unknown>;
const [sanitizePlugin, sanitizeSchema] = sanitize as [unknown, { protocols?: Record<string, string[]> }];
const [hardenPlugin, hardenOptions] = harden as [unknown, Record<string, unknown>];
export const streamdownRehypePlugins = [
  raw,
  [
    sanitizePlugin,
    {
      ...sanitizeSchema,
      protocols: { ...sanitizeSchema.protocols, src: [...(sanitizeSchema.protocols?.src ?? []), "data"] },
    },
  ],
  () => imageToLink,
  [hardenPlugin, { ...hardenOptions, allowedImagePrefixes: [], allowDataImages: true }],
] as NonNullable<StreamdownProps["rehypePlugins"]>;

export const MessageResponse = memo(
  ({ className, children, ...props }: MessageResponseProps) => {
    // Legacy backslash delimiters are converted in a single linear scan;
    // native dollar math passes through to Streamdown unchanged. Incomplete
    // legacy spans are left for a later render when their closer arrives.
    const content =
      typeof children === "string"
        ? transformMathDelimiters(children)
        : children;

    return (
      <Streamdown
        className={cn(
          // Source Sans 3 + emphasis-color tokens on every markdown surface
          // (labels stay JetBrains Mono). Unlayered plain CSS wins over text-sm.
          "lh-prose size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          className
        )}
        components={mdComponents}
        plugins={streamdownPlugins}
        rehypePlugins={streamdownRehypePlugins}
        remend={streamdownRemend}
        {...props}
      >
        {content}
      </Streamdown>
    );
  },
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating
);

MessageResponse.displayName = "MessageResponse";

/** Recovery is a tool-text presentation concern, not a shape/answer-data
 * transform. Ordinary assistant/user prose keeps MessageResponse unchanged. */
export function ToolContentResponse({ children, ...props }: MessageResponseProps) {
  return (
    <MessageResponse {...props}>
      {typeof children === "string" ? repairMathForDisplay(children) : children}
    </MessageResponse>
  );
}

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn(
      "mt-4 flex w-full items-center justify-between gap-4",
      className
    )}
    {...props}
  >
    {children}
  </div>
);
