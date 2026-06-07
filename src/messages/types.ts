export type OutboundMessageKind = "ack" | "status" | "progress" | "final" | "error";

export type OutboundMessageFormat = "plain" | "markdown";

export type OutboundActionStyle = "default" | "primary" | "danger";

export interface OutboundAttachment {
  id?: string;
  filename?: string;
  contentType?: string;
  url?: string;
  bytes?: Uint8Array;
  caption?: string;
}

export interface OutboundAction {
  id: string;
  label: string;
  style?: OutboundActionStyle;
  value?: string;
}

export interface OutboundMessage {
  kind: OutboundMessageKind;
  text: string;
  format?: OutboundMessageFormat;
  replyToMessageId?: string;
  attachments?: OutboundAttachment[];
  actions?: OutboundAction[];
}
