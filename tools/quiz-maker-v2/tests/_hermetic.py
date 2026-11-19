"""Keep browser tests off the real internet.

seal(ctx, allow=(...)) answers every request whose URL does not start with one of the allowed prefixes with an empty
response, so a slow or blocked network (Google Fonts, video hosts, CDNs) can never hold up the page "load" event and
time a test out. Requests to an allowed prefix fall through to the routes the test registered itself.

Call it AFTER the test's own ctx.route(...) calls: Playwright tries the most recently registered route first, and
route.fallback() hands the request on to the earlier ones.

Not a test file itself (no test_ / e2e_ prefix), so the gate does not expect a registry entry for it.
"""

FONT_CSS = "text/css"


def seal(ctx, allow):
    allow = tuple(allow)

    def handler(route):
        url = route.request.url
        if url.startswith(allow):
            return route.fallback()
        ctype = FONT_CSS if url.endswith(".css") or "fonts.googleapis.com" in url else "text/plain"
        return route.fulfill(status=200, content_type=ctype, body="")

    ctx.route("**/*", handler)
    return ctx
