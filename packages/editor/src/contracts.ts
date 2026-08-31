import type { ComponentType } from "react";

/** The semantic editor surface views ask a host to render, without exposing Monaco to the view. */
export interface SqlEditorSurfaceProps {
  uri: string;
  text: string;
  languageId: string;
  ariaLabel: string;
  className?: string;
  readOnly?: boolean;
  lineNumberStart?: number;
  lineNumbers?: "on" | "off";
  placeholder?: string;
  onChange?(text: string): void;
  onSubmit?(text: string): void;
  onCancel?(): void;
  onFocusChange?(focused: boolean): void;
}

export type SqlEditorSurface = ComponentType<SqlEditorSurfaceProps>;
