/** The semantic token kinds a PL/pgSQL routine body produces, shared by every colouring surface. */
export const TOKEN_TYPES = ["variable", "parameter", "type", "function"] as const;
export const TOKEN_MODIFIERS = ["declaration", "readonly"] as const;
