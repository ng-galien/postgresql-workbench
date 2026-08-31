# PostgreSQL 18.4 keyword authority

These are unmodified copies of PostgreSQL's distinct SQL and PL/pgSQL parser
keyword sources at `REL_18_4`:

- SQL: [`kwlist.h`](https://github.com/postgres/postgres/blob/REL_18_4/src/include/parser/kwlist.h), SHA-256 `fdcdf3694513cba63b4016f63032472b686e381bb35f17c5d645bc2f6f1dac16`
- reserved PL/pgSQL: [`pl_reserved_kwlist.h`](https://github.com/postgres/postgres/blob/REL_18_4/src/pl/plpgsql/src/pl_reserved_kwlist.h), SHA-256 `32fdee4aebd1ff76283e36d15946dd81c38251baf3cf118545f986df043e9bac`
- unreserved PL/pgSQL: [`pl_unreserved_kwlist.h`](https://github.com/postgres/postgres/blob/REL_18_4/src/pl/plpgsql/src/pl_unreserved_kwlist.h), SHA-256 `9c137b1d9e88934aabe57305d933ed7b72144bfed98679b2a7058e4527b7a03c`

- PostgreSQL source tag: `REL_18_4`
- SQL syntax authority: the pinned PostgreSQL predictor reports `REL_18_4`
- Runtime owning that grammar in this repository: `@code-moniker/client@0.9.1`
- License: [PostgreSQL License](https://www.postgresql.org/about/licence/); the source files retain their copyright headers

The repository generator reads these inputs into two typed catalogs. SQL and
PL/pgSQL remain separate authorities; application code never edits or merges them.
