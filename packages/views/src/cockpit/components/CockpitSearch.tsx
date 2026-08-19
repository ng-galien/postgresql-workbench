import { useEffect, useId, useRef, useState } from "react";
import { applySearchFacet, searchFacetSuggestions } from "../graph/searchSuggestions.js";
import { useCockpitStore } from "../graph/store.js";
import { focusSymbol } from "../graph/transport.js";
import type { WorkbenchGraphSearchResult } from "../protocol.js";
import { post } from "../vscodeApi.js";

let searchSequence = 0;

export function CockpitSearch() {
  const results = useCockpitStore((state) => state.searchResults);
  const resultQuery = useCockpitStore((state) => state.searchQuery);
  const facets = useCockpitStore((state) => state.session?.searchFacets) ?? {
    schemas: [],
    kinds: [],
  };
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const searchId = useId().replaceAll(":", "");
  const resultsId = `cockpit-search-results-${searchId}`;

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        input.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = ++searchSequence;
      post({ type: "search", requestId: next, query });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [query]);

  const suggestions = searchFacetSuggestions(query, facets);
  const visibleResults = suggestions.length === 0 && resultQuery === query.trim() ? results : [];
  const optionCount = suggestions.length || visibleResults.length;
  const activeId = optionCount > 0 ? `${resultsId}-${active}` : undefined;
  const hasQuery = query.trim().length > 0;

  const keepEditing = (value: string) => {
    setQuery(value);
    setOpen(true);
    setActive(0);
    window.setTimeout(() => input.current?.focus(), 0);
  };
  const chooseFacet = (token: string) => keepEditing(applySearchFacet(query, token));
  const chooseResult = (result: WorkbenchGraphSearchResult) => {
    if (result.resultType === "schema") {
      chooseFacet(`#${result.schema}`);
      return;
    }
    setOpen(false);
    setQuery("");
    focusSymbol(result.symbolUri);
  };
  const chooseActive = () => {
    const suggestion = suggestions[active];
    if (suggestion) chooseFacet(suggestion.token);
    else if (visibleResults[active]) chooseResult(visibleResults[active]);
  };

  return (
    <div className="cockpit-search">
      <span aria-hidden="true">⌕</span>
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-label="Search PostgreSQL objects; use # for schemas and @ for types"
        aria-expanded={open}
        aria-controls={resultsId}
        aria-activedescendant={activeId}
        placeholder="Search an object…  #schema  @type"
        value={query}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && optionCount > 0) {
            event.preventDefault();
            setActive((value) => Math.min(optionCount - 1, value + 1));
          } else if (event.key === "ArrowUp" && optionCount > 0) {
            event.preventDefault();
            setActive((value) => Math.max(0, value - 1));
          } else if (event.key === "Enter" && optionCount > 0) {
            event.preventDefault();
            chooseActive();
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      <kbd>{navigator.platform.toLocaleLowerCase().includes("mac") ? "⌘K" : "Ctrl K"}</kbd>
      {open && (
        <div className="cockpit-results">
          <div id={resultsId} className="search-options" role="listbox">
            {!hasQuery ? (
              <SearchPrimer choose={keepEditing} />
            ) : suggestions.length > 0 ? (
              suggestions.map((suggestion, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  id={`${resultsId}-${index}`}
                  key={suggestion.token}
                  className={index === active ? "active" : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => chooseFacet(suggestion.token)}
                >
                  <span className="facet-symbol">{suggestion.kind === "schema" ? "#" : "@"}</span>
                  <span className="result-copy">
                    <strong>{suggestion.label}</strong>
                    <small>{suggestion.kind === "schema" ? "schema" : "object type"}</small>
                  </span>
                  <span className="result-action">Add filter</span>
                </button>
              ))
            ) : visibleResults.length > 0 ? (
              visibleResults.map((result, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  id={`${resultsId}-${index}`}
                  key={`${result.symbolUri}:${result.label}`}
                  className={index === active ? "active" : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => chooseResult(result)}
                >
                  <span className={`result-kind kind-${result.kind}`}>
                    {result.kind.slice(0, 1)}
                  </span>
                  <span className="result-copy">
                    <strong>{result.label}</strong>
                    <small>
                      {result.schema} · {result.detail}
                    </small>
                  </span>
                  {result.resultType === "schema" ? (
                    <span className="result-action">Use #{result.schema}</span>
                  ) : (
                    <span className={`result-degrees ${result.countStatus}`}>
                      {result.countStatus === "available"
                        ? `▲ ${result.incoming ?? 0} · ▼ ${result.outgoing ?? 0}`
                        : result.countStatus === "unavailable"
                          ? "neighbors unavailable"
                          : "counting…"}
                    </span>
                  )}
                </button>
              ))
            ) : resultQuery === query.trim() ? (
              <span className="search-message">No matching PostgreSQL object.</span>
            ) : (
              <span className="search-message">Searching…</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SearchPrimer({ choose }: { choose: (value: string) => void }) {
  return (
    <div className="search-primer">
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose("#")}
      >
        <span className="facet-symbol">#</span>
        <span>
          <strong>Filter by schema</strong>
          <small>Type # to autocomplete database schemas</small>
        </span>
      </button>
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose("@")}
      >
        <span className="facet-symbol">@</span>
        <span>
          <strong>Filter by type</strong>
          <small>Type @ for tables, views, routines, and members</small>
        </span>
      </button>
      <p>
        Combine filters with free text, for example <code>#shop @table order</code>.
      </p>
    </div>
  );
}
