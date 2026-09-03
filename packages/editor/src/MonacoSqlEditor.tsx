import { KeyCode, editor as monacoEditor } from "@codingame/monaco-vscode-editor-api";
import { MonacoEditorReactComp } from "@typefox/monaco-editor-react";
import type { EditorApp, EditorAppConfig } from "monaco-languageclient/editorApp";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SqlEditorSurfaceProps } from "./contracts.js";
import { ensureEditorFile } from "./fileSystem.js";
import { WORKBENCH_MONACO_THEME } from "./theme.js";
import { useWorkbenchMonacoTheme } from "./useWorkbenchMonacoTheme.js";

/** Thin React lifecycle adapter around TypeFox's EditorApp; all language features come from LSP. */
export function MonacoSqlEditor(props: SqlEditorSurfaceProps) {
  ensureEditorFile(props.uri, props.text);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [reprocess, setReprocess] = useState(0);
  const lastExternal = useRef({ text: props.text, readOnly: props.readOnly });
  const theme = useWorkbenchMonacoTheme(document.documentElement);
  const config = useMemo<EditorAppConfig>(
    () => ({
      codeResources: {
        modified: {
          uri: props.uri,
          text: props.text,
          enforceLanguageId: props.languageId,
        },
      },
      readOnly: props.readOnly,
      domReadOnly: props.readOnly,
      languageDef: {
        languageExtensionConfig: { id: props.languageId },
        theme: { name: WORKBENCH_MONACO_THEME, data: theme.data },
      },
      editorOptions: {
        ariaLabel: props.ariaLabel,
        readOnly: props.readOnly,
        domReadOnly: props.readOnly,
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSize,
        lineNumbers:
          props.lineNumbers === "off"
            ? "off"
            : props.lineNumberStart && props.lineNumberStart !== 1
              ? (line) => String(props.lineNumberStart! + line - 1)
              : "on",
        glyphMargin: false,
        folding: false,
        minimap: { enabled: false },
        overviewRulerLanes: 0,
        renderLineHighlight: "none",
        scrollBeyondLastLine: false,
        placeholder: props.placeholder,
        wordBasedSuggestions: "off",
        "semanticHighlighting.enabled": true,
        padding: { top: 6, bottom: 6 },
      },
    }),
    [
      props.ariaLabel,
      props.languageId,
      props.lineNumberStart,
      props.lineNumbers,
      props.placeholder,
      props.readOnly,
      props.text,
      props.uri,
      theme,
    ],
  );

  useEffect(() => {
    const previous = lastExternal.current;
    if (previous.text !== props.text || previous.readOnly !== props.readOnly) {
      lastExternal.current = { text: props.text, readOnly: props.readOnly };
      setReprocess((current) => current + 1);
    }
  }, [props.readOnly, props.text]);

  useEffect(() => {
    monacoEditor.defineTheme(WORKBENCH_MONACO_THEME, theme.data);
    monacoEditor.setTheme(WORKBENCH_MONACO_THEME);
    setReprocess((current) => current + 1);
  }, [theme]);

  const editorStarted = (app?: EditorApp) => {
    const editor = app?.getEditor();
    if (!editor) return;
    editor.onDidFocusEditorText(() => callbacks.current.onFocusChange?.(true));
    editor.onDidBlurEditorText(() => callbacks.current.onFocusChange?.(false));
    if (callbacks.current.onSubmit) {
      editor.addCommand(KeyCode.Enter, () =>
        callbacks.current.onSubmit?.(editor.getModel()?.getValue() ?? ""),
      );
    }
    if (callbacks.current.onCancel) {
      editor.addCommand(KeyCode.Escape, () => callbacks.current.onCancel?.());
    }
  };

  return (
    <MonacoEditorReactComp
      className={props.className}
      style={{ height: "100%", width: "100%" }}
      editorAppConfig={config}
      triggerReprocessConfig={reprocess}
      onEditorStartDone={editorStarted}
      onTextChanged={({ modified }) => {
        if (modified !== undefined) callbacks.current.onChange?.(modified);
      }}
    />
  );
}
