import type { PostgresSyntaxTarget } from "../analysis/postgresSyntax.js";
import type {
  AvailablePlpgsqlSyntaxExpectation,
  AvailablePostgresSqlSyntaxExpectation,
  PlpgsqlSyntaxSlot,
  PostgresSqlSyntaxSlot,
  PostgresSyntaxAuthority,
  PostgresSyntaxExpectationProvider,
  PostgresSyntaxExpectationRequestFor,
  PostgresSyntaxExpectationResultFor,
  PostgresSyntaxFragment,
  PostgresSyntaxIdentifier,
} from "../analysis/syntaxExpectations.js";
import {
  type GeneratedPostgresParserTables,
  PLPGSQL_PREDICTOR_TABLES,
  POSTGRES_PREDICTOR_AUTHORITY,
  SQL_PREDICTOR_TABLES,
} from "./generated/postgresPredictorTables.js";
import {
  PLPGSQL_PREDICTOR_KEYWORDS,
  scanPlpgsqlPredictorSource,
} from "./plpgsqlPredictorLanguage.js";
import type {
  PostgresPredictorDialect,
  PostgresPredictorLexeme,
} from "./postgresPredictorScanner.js";
import {
  POSTGRES_SQL_PREDICTOR_KEYWORDS,
  scanPostgresSqlPredictorSource,
} from "./postgresSqlPredictorLanguage.js";

const MAX_SOURCE_BYTES = 1_048_576;
const MAX_TOKENS = 10_000;
const MAX_PARSER_ACTIONS = 250_000;

const SQL_LOOKAHEAD_TERMINAL: Readonly<Record<string, string>> = {
  FORMAT: "FORMAT_LA",
  NOT: "NOT_LA",
  NULLS_P: "NULLS_LA",
  WITH: "WITH_LA",
  WITHOUT: "WITHOUT_LA",
};

/** Pure TypeScript grammar predictor shared by every LSP transport and host. */
export const postgresSyntaxExpectationProvider: PostgresSyntaxExpectationProvider = {
  async expectedSyntax<TTarget extends PostgresSyntaxTarget>(
    request: PostgresSyntaxExpectationRequestFor<TTarget>,
  ): Promise<PostgresSyntaxExpectationResultFor<TTarget>> {
    return predictPostgresSyntax(request);
  },
};

export function predictPostgresSyntax<TTarget extends PostgresSyntaxTarget>(
  request: PostgresSyntaxExpectationRequestFor<TTarget>,
): PostgresSyntaxExpectationResultFor<TTarget> {
  validateRequest(request);
  if (request.dialect.postgresMajor !== 18) {
    return ambiguous(request, "grammar-dialect-mismatch");
  }
  if (new TextEncoder().encode(request.analysisSource).length > request.budget.maxSourceBytes) {
    return unavailable(request, "truncated");
  }

  const dialect = request.target.language;
  const prefix = request.analysisSource.slice(0, request.analysisOffset);
  const scanned = scanForDialect(prefix, dialect, request.budget.maxTokens);
  if (scanned.error) return ambiguous(request, "lexical-ambiguity");
  if (scanned.truncated) return unavailable(request, "truncated");

  const tokens = [...scanned.tokens];
  const fragment = takeFragment(
    request.analysisSource,
    request.analysisOffset,
    dialect,
    tokens,
    request.budget.maxTokens,
  );
  if (fragment.status === "ambiguous") return ambiguous(request, "lexical-ambiguity");
  const qualifier = dialect === "sql" ? takeQualifier(tokens) : [];

  if (
    request.target.language === "sql" &&
    request.target.entryPoint === "statement" &&
    tokens.some((token) => token.terminal === "';'")
  ) {
    return unavailable(request, "unsupported-entry-point");
  }

  const tables = dialect === "sql" ? SQL_PREDICTOR_TABLES : PLPGSQL_PREDICTOR_TABLES;
  const parser = new PostgresTableParser(tables, dialect === "sql" ? "independent" : "normal");
  const actions = new ActionBudget(request.budget.maxParserActions);
  if (request.target.language === "sql" && request.target.entryPoint === "expression") {
    const mode = tables.terminalByName.MODE_PLPGSQL_EXPR;
    if (mode === undefined) return unavailable(request, "unsupported-entry-point");
    const fed = parser.feed(mode, false, actions);
    if (fed !== "shifted") return parseFailure(request, fed);
  }

  for (const token of tokens) {
    const symbol = tables.terminalByName[token.terminal];
    if (symbol === undefined) return ambiguous(request, "lexical-ambiguity");
    const fed = parser.feed(symbol, namespaceSensitive(dialect, token), actions);
    if (fed !== "shifted") return parseFailure(request, fed);
  }

  if (request.target.language === "sql") {
    const predicted = predictSql(parser, actions, qualifier);
    if (predicted.status !== "available") return parseFailure(request, predicted.status);
    return {
      status: "available",
      regionId: request.regionId,
      target: request.target,
      authority: authority("sql"),
      analysisIdentity: request.analysisIdentity,
      analysisOffset: request.analysisOffset,
      replacementRange: fragment.value.replacementRange,
      fragment: fragment.value.fragment,
      keywords: predicted.keywords,
      slots: predicted.slots,
    } as unknown as PostgresSyntaxExpectationResultFor<TTarget>;
  }

  const predicted = predictPlpgsql(parser, actions, fragment.value.fragment);
  if (predicted.status !== "available") return parseFailure(request, predicted.status);
  return {
    status: "available",
    regionId: request.regionId,
    target: request.target,
    authority: authority("plpgsql"),
    analysisIdentity: request.analysisIdentity,
    analysisOffset: request.analysisOffset,
    replacementRange: fragment.value.replacementRange,
    fragment: fragment.value.fragment,
    keywords: predicted.keywords,
    slots: [] satisfies PlpgsqlSyntaxSlot[],
  } as unknown as PostgresSyntaxExpectationResultFor<TTarget>;
}

function predictSql(
  parser: PostgresTableParser,
  actions: ActionBudget,
  qualifier: readonly PostgresSyntaxIdentifier[],
):
  | {
      status: "available";
      keywords: AvailablePostgresSqlSyntaxExpectation["keywords"];
      slots: PostgresSqlSyntaxSlot[];
    }
  | { status: ParseFailure } {
  const keywords: AvailablePostgresSqlSyntaxExpectation["keywords"][number][] = [];
  for (const keyword of POSTGRES_SQL_PREDICTOR_KEYWORDS) {
    const symbol = parser.tables.terminalByName[keyword.token];
    if (symbol === undefined) continue;
    const accepted = parser.probeDirect(symbol, false, actions);
    const lookahead = SQL_LOOKAHEAD_TERMINAL[keyword.token];
    const lookaheadSymbol = lookahead ? parser.tables.terminalByName[lookahead] : undefined;
    const alternative =
      accepted === "rejected" && lookaheadSymbol !== undefined
        ? parser.probeDirect(lookaheadSymbol, false, actions)
        : accepted;
    if (alternative === "budget" || alternative === "non-local") return { status: alternative };
    if (alternative === "shifted") {
      keywords.push({ language: "sql", kind: "keyword", label: keyword.label });
    }
  }

  const identifier = parser.tables.terminalByName.IDENT;
  if (identifier === undefined) return { status: "available", keywords, slots: [] };
  const probe = parser.probeState(identifier, false, actions);
  if (probe.status === "budget" || probe.status === "non-local") return { status: probe.status };
  const slots =
    probe.status === "shifted" ? sqlSlots(parser.slotMaskAt(probe.state), qualifier) : [];
  return { status: "available", keywords, slots };
}

function predictPlpgsql(
  parser: PostgresTableParser,
  actions: ActionBudget,
  fragment: PostgresSyntaxFragment,
):
  | { status: "available"; keywords: AvailablePlpgsqlSyntaxExpectation["keywords"] }
  | { status: ParseFailure } {
  const keywords: AvailablePlpgsqlSyntaxExpectation["keywords"][number][] = [];
  for (const keyword of PLPGSQL_PREDICTOR_KEYWORDS) {
    const symbol = parser.tables.terminalByName[keyword.token];
    if (symbol === undefined) continue;
    const accepted = parser.probeDirect(symbol, false, actions);
    if (accepted === "budget" || accepted === "non-local") return { status: accepted };
    if (accepted === "shifted") {
      keywords.push({ language: "plpgsql", kind: "keyword", label: keyword.label });
    }
  }
  const identifier = parser.tables.terminalByName.T_WORD;
  if (identifier !== undefined) {
    const accepted = parser.probe(identifier, true, actions);
    if (accepted === "budget") return { status: "budget" };
    if (
      accepted === "non-local" &&
      (fragment.form === "unquoted-identifier" || fragment.form === "quoted-identifier")
    ) {
      return { status: "non-local" };
    }
  }
  return { status: "available", keywords };
}

function sqlSlots(
  mask: number,
  qualifier: readonly PostgresSyntaxIdentifier[],
): PostgresSqlSyntaxSlot[] {
  const slots: PostgresSqlSyntaxSlot[] = [];
  if ((mask & (1 << 0)) !== 0) slots.push({ language: "sql", slot: "relation", qualifier });
  if ((mask & (1 << 1)) !== 0) slots.push({ language: "sql", slot: "column", qualifier });
  if ((mask & (1 << 2)) !== 0)
    slots.push({ language: "sql", slot: "routine", invocation: "function", qualifier });
  if ((mask & (1 << 3)) !== 0) slots.push({ language: "sql", slot: "type", qualifier });
  if ((mask & (1 << 4)) !== 0) {
    const withoutFunction = slots.filter(
      (slot) => slot.slot !== "routine" || slot.invocation !== "function",
    );
    return [
      ...withoutFunction,
      { language: "sql", slot: "routine", invocation: "procedure", qualifier },
    ];
  }
  return slots;
}

function takeFragment(
  source: string,
  offset: number,
  dialect: PostgresPredictorDialect,
  tokens: PostgresPredictorLexeme[],
  maxTokens: number,
):
  | {
      status: "available";
      value: { fragment: PostgresSyntaxFragment; replacementRange: { start: number; end: number } };
    }
  | { status: "ambiguous" } {
  const token = tokens.at(-1);
  if (!token || token.end !== offset || !isFragment(token)) {
    return {
      status: "available",
      value: {
        fragment: { written: "", canonical: "", form: "none" },
        replacementRange: { start: offset, end: offset },
      },
    };
  }
  tokens.pop();
  const complete = scanForDialect(source, dialect, maxTokens);
  if (complete.truncated) return { status: "ambiguous" };
  const whole = complete.tokens.find(
    (candidate) => candidate.start === token.start && isFragment(candidate),
  );
  const selected = whole && !whole.terminal.endsWith("_LA") ? whole : token;
  const written = source.slice(token.start, selected.end);
  const canonical = selected.canonical ?? written.toLocaleLowerCase();
  return {
    status: "available",
    value: {
      fragment: {
        written,
        canonical,
        form:
          token.form === "quoted-identifier"
            ? "quoted-identifier"
            : token.form === "keyword"
              ? "keyword"
              : "unquoted-identifier",
      },
      replacementRange: { start: token.start, end: selected.end },
    },
  };
}

function isFragment(token: PostgresPredictorLexeme): boolean {
  return (
    token.form === "identifier" || token.form === "quoted-identifier" || token.form === "keyword"
  );
}

function scanForDialect(source: string, dialect: PostgresPredictorDialect, maxTokens: number) {
  return dialect === "sql"
    ? scanPostgresSqlPredictorSource(source, maxTokens)
    : scanPlpgsqlPredictorSource(source, maxTokens);
}

function takeQualifier(tokens: readonly PostgresPredictorLexeme[]): PostgresSyntaxIdentifier[] {
  const reversed: PostgresSyntaxIdentifier[] = [];
  let index = tokens.length;
  while (index >= 2 && tokens[index - 1]?.terminal === "'.'") {
    const identifier = tokens[index - 2];
    if (!identifier) return [];
    const hasQualifierToLeft = index >= 3 && tokens[index - 3]?.terminal === "'.'";
    const accepted =
      identifier.form === "identifier" ||
      identifier.form === "quoted-identifier" ||
      (identifier.form === "keyword" &&
        (hasQualifierToLeft ||
          identifier.keywordCategory === "U" ||
          identifier.keywordCategory === "C"));
    if (!accepted) return [];
    reversed.push({
      written: identifier.written,
      canonical: identifier.canonical ?? identifier.written.toLocaleLowerCase(),
      quoted: identifier.form === "quoted-identifier",
    });
    index -= 2;
  }
  return reversed.reverse();
}

function namespaceSensitive(
  dialect: PostgresPredictorDialect,
  token: PostgresPredictorLexeme,
): boolean {
  return dialect === "plpgsql" && (token.terminal === "T_WORD" || token.terminal === "T_CWORD");
}

type ParseFailure = "rejected" | "non-local" | "budget";
type FeedResult = "shifted" | ParseFailure;

class PostgresTableParser {
  readonly stack = [0];
  private lookupMode: "independent" | "declare" | "normal" | "expression";

  constructor(
    readonly tables: GeneratedPostgresParserTables,
    lookupMode: "independent" | "declare" | "normal" | "expression",
  ) {
    this.lookupMode = lookupMode;
  }

  feed(symbol: number, namespaceSensitive: boolean, budget: ActionBudget): FeedResult {
    return this.feedState(symbol, namespaceSensitive, budget).status;
  }

  probe(symbol: number, namespaceSensitive: boolean, budget: ActionBudget): FeedResult {
    return this.probeState(symbol, namespaceSensitive, budget).status;
  }

  probeDirect(symbol: number, namespaceSensitive: boolean, budget: ActionBudget): FeedResult {
    const probe = this.probeState(symbol, namespaceSensitive, budget);
    if (probe.status !== "shifted") return probe.status;
    return this.tables.directTerminals[probe.state]?.includes(symbol) ? "shifted" : "rejected";
  }

  probeState(
    symbol: number,
    namespaceSensitive: boolean,
    budget: ActionBudget,
  ): { status: FeedResult; state: number } {
    const candidate = this.clone();
    return candidate.feedState(symbol, namespaceSensitive, budget);
  }

  slotMaskAt(state: number): number {
    const direct = this.tables.slotMasks[state] ?? 0;
    if (direct !== 0) return direct;
    for (let index = this.stack.length - 1; index >= 1; index -= 1) {
      const mask = this.tables.slotMasks[this.stack[index] ?? 0] ?? 0;
      if (mask !== 0) return mask;
    }
    return 0;
  }

  private feedState(
    symbol: number,
    namespaceSensitive: boolean,
    budget: ActionBudget,
  ): { status: FeedResult; state: number } {
    while (true) {
      const state = this.stack.at(-1) ?? 0;
      const action = this.tableAction(state, symbol);
      if (action.kind === "shift") {
        if (
          namespaceSensitive &&
          (this.lookupMode === "normal" || this.lookupMode === "expression")
        ) {
          return { status: "non-local", state };
        }
        if (!budget.consume()) return { status: "budget", state };
        this.stack.push(action.state);
        return { status: "shifted", state };
      }
      if (action.kind === "reduce") {
        if (!budget.consume()) return { status: "budget", state };
        const reduced = this.reduce(action.rule);
        if (reduced !== "shifted") return { status: reduced, state };
        continue;
      }
      if (action.kind === "accept") return { status: "shifted", state };
      return { status: "rejected", state };
    }
  }

  private reduce(rule: number): FeedResult {
    if (this.tables.nonlocalReductions[rule] === 1) return "non-local";
    const length = this.tables.yyr2[rule];
    const lhsSymbol = this.tables.yyr1[rule];
    if (length === undefined || lhsSymbol === undefined || length >= this.stack.length) {
      return "rejected";
    }
    this.stack.length -= length;
    const state = this.stack.at(-1) ?? 0;
    const lhs = lhsSymbol - this.tables.terminalCount;
    const candidate = (this.tables.yypgoto[lhs] ?? 0) + state;
    const next =
      candidate >= 0 &&
      candidate <= this.tables.lastIndex &&
      this.tables.yycheck[candidate] === state
        ? this.tables.yytable[candidate]
        : this.tables.yydefgoto[lhs];
    if (next === undefined) return "rejected";
    this.stack.push(next);
    const lookup = this.tables.lookupModeReductions[rule];
    if (lookup === 1) this.lookupMode = "declare";
    else if (lookup === 2) this.lookupMode = "normal";
    else if (lookup === 3) this.lookupMode = "expression";
    return "shifted";
  }

  private tableAction(
    state: number,
    symbol: number,
  ):
    | { kind: "shift"; state: number }
    | { kind: "reduce"; rule: number }
    | { kind: "accept" }
    | { kind: "reject" } {
    if (state === this.tables.finalState) return { kind: "accept" };
    const pact = this.tables.yypact[state];
    if (pact !== undefined && pact !== this.tables.pactNinf) {
      const index = pact + symbol;
      if (index >= 0 && index <= this.tables.lastIndex && this.tables.yycheck[index] === symbol) {
        const action = this.tables.yytable[index] ?? 0;
        if (action > 0) return { kind: "shift", state: action };
        if (action < 0 && action !== this.tables.tableNinf) {
          return { kind: "reduce", rule: -action };
        }
        return { kind: "reject" };
      }
    }
    const rule = this.tables.yydefact[state] ?? 0;
    return rule === 0 ? { kind: "reject" } : { kind: "reduce", rule };
  }

  private clone(): PostgresTableParser {
    const clone = new PostgresTableParser(this.tables, this.lookupMode);
    clone.stack.splice(0, clone.stack.length, ...this.stack);
    return clone;
  }
}

class ActionBudget {
  private used = 0;

  constructor(private readonly limit: number) {}

  consume(): boolean {
    if (this.used === this.limit) return false;
    this.used += 1;
    return true;
  }
}

function validateRequest(request: PostgresSyntaxExpectationRequestFor<PostgresSyntaxTarget>): void {
  const { budget } = request;
  if (
    !Number.isInteger(budget.maxSourceBytes) ||
    !Number.isInteger(budget.maxTokens) ||
    !Number.isInteger(budget.maxParserActions) ||
    budget.maxSourceBytes <= 0 ||
    budget.maxTokens <= 0 ||
    budget.maxParserActions <= 0 ||
    budget.maxSourceBytes > MAX_SOURCE_BYTES ||
    budget.maxTokens > MAX_TOKENS ||
    budget.maxParserActions > MAX_PARSER_ACTIONS
  ) {
    throw new Error("PostgreSQL prediction budgets must be positive and within application limits");
  }
  if (
    !Number.isInteger(request.analysisOffset) ||
    request.analysisOffset < 0 ||
    request.analysisOffset > request.analysisSource.length ||
    splitsSurrogatePair(request.analysisSource, request.analysisOffset)
  ) {
    throw new Error("PostgreSQL prediction offset is not a UTF-16 boundary in analysisSource");
  }
}

function splitsSurrogatePair(source: string, offset: number): boolean {
  if (offset <= 0 || offset >= source.length) return false;
  const previous = source.charCodeAt(offset - 1);
  const next = source.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

function authority(language: "sql" | "plpgsql"): PostgresSyntaxAuthority {
  return {
    postgresRef: POSTGRES_PREDICTOR_AUTHORITY.postgresRef,
    generator: {
      name: "gnu-bison",
      version: POSTGRES_PREDICTOR_AUTHORITY.generatorVersion,
    },
    grammarDigest:
      language === "sql"
        ? POSTGRES_PREDICTOR_AUTHORITY.sqlGrammarDigest
        : POSTGRES_PREDICTOR_AUTHORITY.plpgsqlGrammarDigest,
    scannerDigest: POSTGRES_PREDICTOR_AUTHORITY.scannerDigest,
    keywordDigest:
      language === "sql"
        ? POSTGRES_PREDICTOR_AUTHORITY.sqlKeywordDigest
        : POSTGRES_PREDICTOR_AUTHORITY.plpgsqlKeywordDigest,
    predictorDigest: POSTGRES_PREDICTOR_AUTHORITY.predictorDigest,
    projectionDigest: POSTGRES_PREDICTOR_AUTHORITY.projectionDigest,
  };
}

function parseFailure<TTarget extends PostgresSyntaxTarget>(
  request: PostgresSyntaxExpectationRequestFor<TTarget>,
  failure: FeedResult,
): PostgresSyntaxExpectationResultFor<TTarget> {
  if (failure === "budget") return unavailable(request, "truncated");
  return ambiguous(request, failure === "non-local" ? "non-local-state" : "parser-recovery");
}

function ambiguous<TTarget extends PostgresSyntaxTarget>(
  request: PostgresSyntaxExpectationRequestFor<TTarget>,
  reason: "parser-recovery" | "non-local-state" | "lexical-ambiguity" | "grammar-dialect-mismatch",
): PostgresSyntaxExpectationResultFor<TTarget> {
  return { status: "ambiguous", regionId: request.regionId, target: request.target, reason };
}

function unavailable<TTarget extends PostgresSyntaxTarget>(
  request: PostgresSyntaxExpectationRequestFor<TTarget>,
  reason: "unsupported-entry-point" | "truncated",
): PostgresSyntaxExpectationResultFor<TTarget> {
  return { status: "unavailable", regionId: request.regionId, target: request.target, reason };
}
