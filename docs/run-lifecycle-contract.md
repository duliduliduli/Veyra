# Run view lifecycle

Run detail, report, polling, cancellation, history pagination and artifact UI effects belong to the route visit that started them. The browser's existing route generation invalidates a visit even after leaving and returning to the exact same URL; each detail load also has its own identity so an earlier poll cannot replace a newer cancellation refresh.

- Starting a detail load clears the old report and disables its actions, hides Stop until the current job is known, and replaces the prior polling timer. Only the current load can render a job/report, report a read error or schedule its next poll.
- Stop captures the currently loaded live job, never a newly navigated hash. Repeated requests in one visit are blocked. A successful old cancellation may have affected the originally requested job on the server, but cannot clear another visit's timer, reopen its old run or change the new view's controls/status. Closing/navigating does not undo a request already sent. The status explains that running compute can continue until the next checkpoint; the final receipt records measured usage.
- History responses and errors check both request and route-visit identity. A fresh scope immediately clears the previous scope's rows/counts and shows loading, then an honest empty failed-load state if the request fails. Failed pagination retains every loaded row and the cursor; retry appends and deduplicates normally. An old completion cannot reset the current Load older runs button.
- A deliberately requested artifact download may finish after navigation. It always uses its captured report ID and artifact type. Only its originating detail load owns button and error updates; another run's pending or unavailable controls stay unchanged. This does not start a run, publish source or add a charge.

No backend/API contract, authentication, pricing, execution, persistent storage or styling changes are included.

## Verification

`NODE_PATH=/path/to/jsdom/node_modules node --test tests/e2e/run-lifecycle-ui.mjs`

The suite uses synthetic API responses and controlled polling callbacks. It covers same-URL revisit races, old job/report errors, Stop during loading, cancellation across routes and overlapping polls, obsolete timer callbacks, pagination failure/retry, artifact identity and independent button ownership.

Native browser behavior and live PostgreSQL/API integration are not covered by this suite. No actual cancellation, download, execution or billing operation was performed.
