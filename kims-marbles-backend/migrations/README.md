# Database migrations

`npm run migrate` (in `server/`) applies, in order, every `NNNN_name.sql` here that the
database has not seen, each in its own transaction, and records it in `schema_migrations`.
`0001_initial` is `schema.sql` + `rls.sql` and is applied by the runner itself.

To change the schema: add the next file (e.g. `0002_add_listing_views.sql`), and make the
same change in `schema.sql` so fresh installs and tests match. Never edit a migration that
has already run on the live database; add a new one.
