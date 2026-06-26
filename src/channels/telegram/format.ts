import type { OutboundMessage } from "../../messages/types.ts";

export const TELEGRAM_MAX_TEXT_LENGTH = 4_096;
const TELEGRAM_RENDER_HEADROOM = 64;

export type TelegramParseMode = "HTML";

export interface TelegramRenderedText {
  text: string;
  parseMode?: TelegramParseMode;
  disableWebPagePreview?: boolean;
}

export function telegramOutboundText(message: OutboundMessage): string {
  return message.text.length > 0 ? message.text : " ";
}

export function renderTelegramMessage(message: OutboundMessage, maxLength = TELEGRAM_MAX_TEXT_LENGTH): TelegramRenderedText[] {
  const text = telegramOutboundText(message);

  if (message.format !== "markdown") {
    return splitTelegramText(text, maxLength).map((chunk) => ({ text: chunk }));
  }

  return splitMarkdownBlocks(text, Math.max(1, maxLength - TELEGRAM_RENDER_HEADROOM))
    .flatMap((chunk) => renderMarkdownChunk(chunk, maxLength));
}

export function splitTelegramText(text: string, maxLength = TELEGRAM_MAX_TEXT_LENGTH): string[] {
  if (maxLength < 1) throw new Error("maxLength must be greater than zero");
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf("\n", maxLength);

    if (splitIndex < Math.floor(maxLength / 2)) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);

    if (remaining.startsWith("\n")) {
      remaining = remaining.slice(1);
    }
  }

  if (remaining.length > 0) chunks.push(remaining);

  return chunks;
}

function renderMarkdownChunk(chunk: string, maxLength: number): TelegramRenderedText[] {
  const rendered = markdownToTelegramHtml(chunk);

  if (rendered.length <= maxLength) {
    return [{ text: rendered, parseMode: "HTML", disableWebPagePreview: true }];
  }

  return splitMarkdownBlocks(chunk, Math.max(1, maxLength - TELEGRAM_RENDER_HEADROOM * 2))
    .flatMap((part) => {
      const html = markdownToTelegramHtml(part);
      if (html.length <= maxLength) return [{ text: html, parseMode: "HTML" as const, disableWebPagePreview: true }];

      return splitTelegramText(part, Math.max(1, maxLength - TELEGRAM_RENDER_HEADROOM * 2))
        .map((plainPart) => ({
          text: markdownToTelegramHtml(plainPart),
          parseMode: "HTML" as const,
          disableWebPagePreview: true,
        }));
    });
}

function splitMarkdownBlocks(text: string, maxLength: number): string[] {
  if (maxLength < 1) throw new Error("maxLength must be greater than zero");
  if (text.length <= maxLength) return [text];

  const blocks = markdownBlocks(text, maxLength);
  const chunks: string[] = [];
  let current = "";

  for (const block of blocks) {
    const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";

    if (current.length > 0 && current.length + separator.length + block.length > maxLength) {
      chunks.push(current.trimEnd());
      current = block;
      continue;
    }

    current = current ? `${current}${separator}${block}` : block;
  }

  if (current.length > 0) chunks.push(current.trimEnd());
  return chunks.length > 0 ? chunks : [""];
}

function markdownBlocks(text: string, maxLength: number): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  for (const line of lines) {
    const isFence = line.trimStart().startsWith("```");

    if (!inFence && isFence) {
      flushCurrent();
      current = [line];
      inFence = true;
      continue;
    }

    current.push(line);

    if (inFence) {
      if (isFence && current.length > 1) {
        pushPossiblyLongBlock(current.join("\n"));
        current = [];
        inFence = false;
      }
      continue;
    }

    if (line.trim() === "") {
      flushCurrent();
    }
  }

  flushCurrent();
  return blocks;

  function flushCurrent(): void {
    if (current.length === 0) return;

    pushPossiblyLongBlock(current.join("\n"));
    current = [];
  }

  function pushPossiblyLongBlock(block: string): void {
    if (block.length <= maxLength) {
      blocks.push(block);
      return;
    }

    if (block.trimStart().startsWith("```")) {
      blocks.push(...splitFencedCodeBlock(block, maxLength));
      return;
    }

    blocks.push(...splitTelegramText(block, maxLength));
  }
}

function splitFencedCodeBlock(block: string, maxLength: number): string[] {
  const lines = block.split("\n");
  const opening = lines[0] ?? "```";
  const hasClosing = lines.length > 1 && (lines.at(-1) ?? "").trimStart().startsWith("```");
  const closing = hasClosing ? lines.at(-1) ?? "```" : "```";
  const body = lines.slice(1, hasClosing ? -1 : undefined).join("\n");
  const overhead = opening.length + closing.length + 2;
  const bodyLimit = Math.max(1, maxLength - overhead);

  return splitTelegramText(body, bodyLimit).map((part) => `${opening}\n${part}\n${closing}`);
}

function markdownToTelegramHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let paragraphLines: string[] = [];
  let inFence = false;
  let fenceLanguage: string | undefined;
  let fenceLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimStart();

    if (trimmed.startsWith("```")) {
      if (!inFence) {
        flushParagraph();
        inFence = true;
        fenceLanguage = trimmed.slice(3).trim().split(/\s+/)[0];
        fenceLines = [];
      } else {
        appendMarkdownBlock(output, renderCodeBlock(fenceLines.join("\n"), fenceLanguage));
        inFence = false;
        fenceLanguage = undefined;
        fenceLines = [];
      }
      continue;
    }

    if (inFence) {
      fenceLines.push(line);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      appendBlankLine(output);
      continue;
    }

    const listLine = renderListLine(line);
    if (listLine) {
      flushParagraph();
      appendMarkdownBlock(output, listLine);
      continue;
    }

    paragraphLines.push(line);
  }

  flushParagraph();

  if (inFence) {
    appendMarkdownBlock(output, renderCodeBlock(fenceLines.join("\n"), fenceLanguage));
  }

  return output.join("\n").trim();

  function flushParagraph(): void {
    if (paragraphLines.length === 0) return;

    appendMarkdownBlock(output, renderMarkdownParagraph(paragraphLines));
    paragraphLines = [];
  }
}

function renderCodeBlock(code: string, language: string | undefined): string {
  const languageClass = language ? ` class="language-${escapeHtmlAttribute(language)}"` : "";
  return `<pre><code${languageClass}>${escapeHtml(code)}</code></pre>`;
}

function renderMarkdownLine(line: string): string {
  const heading = /^(#{1,6})\s+(.+)$/.exec(line);

  if (heading) {
    return `<b>${renderInlineMarkdown(heading[2] ?? "")}</b>`;
  }

  return renderInlineMarkdown(line);
}

function renderMarkdownParagraph(lines: string[]): string {
  if (lines.length === 1) return renderMarkdownLine(lines[0] ?? "");

  return renderInlineMarkdown(joinParagraphLines(lines));
}

function joinParagraphLines(lines: string[]): string {
  return lines.reduce((paragraph, line, index) => {
    const trimmed = line.trim();
    if (index === 0) return trimmed;

    const previous = lines[index - 1] ?? "";
    const separator = / {2,}$/.test(previous) ? "\n" : " ";
    return `${paragraph}${separator}${trimmed}`;
  }, "");
}

interface MarkdownListLine {
  indent: string;
  marker: string;
  orderedNumber?: string;
  content: string;
}

function renderListLine(line: string): string | undefined {
  const parsed = parseListLine(line);
  if (!parsed) return undefined;

  const task = parseTaskListContent(parsed.content);
  const marker = task?.marker ?? (parsed.orderedNumber ? `${parsed.orderedNumber}.` : "•");
  const content = task?.content ?? parsed.content;

  return `${parsed.indent}${marker} ${renderInlineMarkdown(content.trim())}`;
}

function parseListLine(line: string): MarkdownListLine | undefined {
  const unordered = /^(\s*)([-*+])\s+(.+)$/.exec(line);
  if (unordered) {
    return {
      indent: listIndent(unordered[1] ?? ""),
      marker: unordered[2] ?? "•",
      content: unordered[3] ?? "",
    };
  }

  const ordered = /^(\s*)(\d+)[.)]\s+(.+)$/.exec(line);
  if (ordered) {
    return {
      indent: listIndent(ordered[1] ?? ""),
      marker: ordered[2] ?? "1",
      orderedNumber: ordered[2] ?? "1",
      content: ordered[3] ?? "",
    };
  }

  return undefined;
}

function parseTaskListContent(content: string): { marker: string; content: string } | undefined {
  const task = /^\[([ xX])\]\s+(.+)$/.exec(content.trimStart());
  if (!task) return undefined;

  return {
    marker: task[1]?.toLowerCase() === "x" ? "✅" : "⬜",
    content: task[2] ?? "",
  };
}

function listIndent(rawIndent: string): string {
  const spaces = rawIndent.replaceAll("\t", "  ").length;
  return "  ".repeat(Math.min(Math.floor(spaces / 2), 6));
}

function appendMarkdownBlock(output: string[], block: string): void {
  if (!block) return;
  output.push(block);
}

function appendBlankLine(output: string[]): void {
  if (output.length === 0 || output.at(-1) === "") return;
  output.push("");
}

function renderInlineMarkdown(text: string): string {
  let output = "";
  let index = 0;

  while (index < text.length) {
    if (text.startsWith("`", index)) {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        output += `<code>${escapeHtml(text.slice(index + 1, end))}</code>`;
        index = end + 1;
        continue;
      }
    }

    if (text.startsWith("[", index)) {
      const link = parseMarkdownLink(text, index);
      if (link) {
        output += `<a href="${escapeHtmlAttribute(link.url)}">${renderInlineMarkdown(link.label)}</a>`;
        index = link.endIndex;
        continue;
      }
    }

    const strong = parseDelimited(text, index, "**") ?? parseDelimited(text, index, "__");
    if (strong) {
      output += `<b>${renderInlineMarkdown(strong.content)}</b>`;
      index = strong.endIndex;
      continue;
    }

    const emphasis = parseDelimited(text, index, "*") ?? parseDelimited(text, index, "_");
    if (emphasis) {
      output += `<i>${renderInlineMarkdown(emphasis.content)}</i>`;
      index = emphasis.endIndex;
      continue;
    }

    output += escapeHtml(text[index] ?? "");
    index += 1;
  }

  return output;
}

function parseMarkdownLink(text: string, startIndex: number): { label: string; url: string; endIndex: number } | undefined {
  const labelEnd = text.indexOf("](", startIndex + 1);
  if (labelEnd === -1) return undefined;

  const urlEnd = text.indexOf(")", labelEnd + 2);
  if (urlEnd === -1) return undefined;

  const label = text.slice(startIndex + 1, labelEnd);
  const url = text.slice(labelEnd + 2, urlEnd).trim();

  if (!label || !isSafeLinkUrl(url)) return undefined;

  return { label, url, endIndex: urlEnd + 1 };
}

function parseDelimited(text: string, startIndex: number, delimiter: string): { content: string; endIndex: number } | undefined {
  if (!text.startsWith(delimiter, startIndex)) return undefined;

  const contentStart = startIndex + delimiter.length;
  const end = text.indexOf(delimiter, contentStart);

  if (end <= contentStart) return undefined;

  const content = text.slice(contentStart, end);
  if (!content.trim()) return undefined;
  if (delimiter.length === 1 && shouldAvoidEmphasis(text, startIndex, end, delimiter)) return undefined;

  return { content, endIndex: end + delimiter.length };
}

function shouldAvoidEmphasis(text: string, start: number, end: number, delimiter: string): boolean {
  if (delimiter !== "_") return false;

  const before = text[start - 1];
  const after = text[end + 1];
  return isWordChar(before) || isWordChar(after);
}

function isWordChar(value: string | undefined): boolean {
  return Boolean(value && /[A-Za-z0-9]/.test(value));
}

function isSafeLinkUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || /^mailto:/i.test(url);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}
