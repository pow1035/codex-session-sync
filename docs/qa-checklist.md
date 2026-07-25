# QA checklist

- Run isolated fixtures without touching live databases.
- Run the terminal launcher against live state and confirm clear anomaly output.
- Confirm both integrity checks are `ok`.
- Confirm a second no-change run is idempotent.
- Confirm active rollout files, active models, archive tombstones, and pair title
  symmetry with direct queries.
- Confirm Git contains only source, tests, and documentation.
