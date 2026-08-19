export interface PlApiStep {
  oid: number;
  line: number;
  md5: string;
}

export interface PlApiStackFrame {
  level: number;
  oid: number;
  line: number;
  md5: string;
}

export interface PlApiValue {
  oid: number;
  name: string;
  type: string;
  kind: string;
  isArray: boolean;
  isText: boolean;
  arrayType: string;
  value: string;
  pretty: string;
}

export interface PlApiStackVariable {
  varNo: number;
  isArg: boolean;
  line: number;
  value: PlApiValue;
}

export interface PlApiFunctionArg {
  oid: number;
  nb: number;
  pos: number;
  name: string;
  type: string;
  hasDefault: boolean;
}

export interface PlApiFunctionDef {
  oid: number;
  schema: string;
  name: string;
  source: string;
  body: string;
  md5: string;
}

export interface PlApiExtension {
  schema: string;
  name: string;
  version: string;
}

export interface ConnectionDiagnostic {
  sharedLibraryOk: boolean;
  sharedLibraries: string;
  extensionOk: boolean;
  extensions: string;
}
