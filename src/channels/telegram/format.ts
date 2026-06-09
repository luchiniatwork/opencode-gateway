import type { OutboundMessage } from "../../messages/types.ts";

export const TELEGRAM_MAX_TEXT_LENGTH = 4_096;

export function telegramOutboundText(message: OutboundMessage): string {
  return message.text.length > 0 ? message.text : " ";
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
