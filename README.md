# Gift Huddle

A group gift picker for South Africa. Friends each add what they know about the person, then the app suggests gifts that fit the budget (in rand), the recipient's city, and the date the gift is needed by.

## Run it

```bash
npm install
npm start
```

Then open http://localhost:3000.

## Optional features

Copy `.env.example` to `.env` and add the keys you have:

- `ANTHROPIC_API_KEY` switches on "Ask AI for ideas".
- `SERPAPI_KEY` switches on "Check live prices" (Google Shopping results for South Africa).

Without keys the app still works, using its built-in list of gift ideas.
