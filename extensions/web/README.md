The browser channel: an HTTP listener on loopback that serves the web UI, the browser API and the event stream.

Enabled by default. The core starts no listener of its own: with `web` off, Ultimate runs with no open port, and other
channels reach conversations through `ChannelHost`. Turn it off with `"extensions": { "disable": ["web"] }` in
settings; the change applies live, and turning it on again binds the same port.

## Port and lifecycle

The listener binds `127.0.0.1` on `--port` or `ULTIMATE_PORT`, else 4747. Under the supervisor with no port requested,
it takes the first free port from 4747, and every later core binds that port again, so the URL stays across swaps and
restarts. It listens once storage is open (`onOpen`) and stops on release, before the next core opens. A connection
can fail during that handoff; the page reconnects and reloads its saved state. If it cannot listen, a notice says why
and the runtime goes on without a browser.

`system.process.url` holds the URL while it listens. The supervisor writes the port into `ultimate.lock`, which
project discovery (`ultimate.projects()`) reads. Without a listener there is no URL, and nothing advertises one.

## Files

- `server.ts`: the listener, request admission (`server/request-security.ts`) and the frame policy.
- `routes.ts`: the `/api/*` routes and the `/api/events` stream. Extensions reach each other with `host.need`,
  `host.want` and `host.invoke`, not through these routes.
- `bundle.ts`: the production bundle of `web/` and every enabled `web.tsx`, built by `server/web-build.ts` in a child
  process.

The core's side is `server/web-channel.ts`: `host.webChannel()`, which only this extension may call.
