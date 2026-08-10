export interface DebugLaunchRoutineTarget {
  symbolUri?: string;
  schema: string | null;
  name: string;
  kind: "function" | "procedure";
  oid?: number;
  argTypes?: string[];
}

export interface DebugLaunchRoutineArgument {
  value: string | null;
}

export function routineDisplayName(target: DebugLaunchRoutineTarget): string {
  return target.schema ? `${target.schema}.${target.name}` : target.name;
}
