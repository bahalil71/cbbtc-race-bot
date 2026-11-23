# cbBTC/USDC race bot

An entry for make.fun's *Race a BTC trading bot live for 24 hours* bounty.
Speaks `agent-fun/bars-replay/v1`: newline-delimited JSON on stdin and stdout,
one reply per one-minute bar.

## Why it trades the way it does

One asset (cbBTC/USDC, an Orca Whirlpool), long only, 1,000 USDC of paper money.
A full-size round trip costs about **26 bps** — 4 bps fee each way, the pool's
0.04% swap fee, 2 bps of modelled slippage, and price impact against the pool
depth. That single number decides the whole design: a bot that trades every wiggle
pays away more than the market moves, and a bot that never trades sits at exactly
zero and fails the dev gate.

So this bot:

- **Sizes entry against the pool depth it can see.** `state.impactBps()` reports what
  a trade of a given size would pay on the latest close's depth; the size is walked
  down until the modelled impact sits under a fixed cap, so the cost of getting in
  is a known quantity rather than a surprise.
- **Treats the position against what it actually paid.** `positions.get().cost`
  carries fees, so the profit test uses the real entry, not the price at the top of
  the bar.
- **Takes profit on a move far larger than the round trip's cost**, and otherwise
  stays in — the day's move is the prize, not each wiggle.
- **Pauses after a round trip** so the chop cannot be traded repeatedly.
- **Only re-enters above its own short average**, so it does not buy back into a
  fall it just exited.

## Layout

- `main.ts` — the strategy; the entrypoint the grader runs (`node /bot/main.ts`)
- `vendor/makefun-bars.ts` — a byte-identical copy of the kit's SDK shim, kept under
  `vendor/` as the rules allow
- `LICENSE` — MIT

## Running it

The kit ships the harness and a local grader:

```bash
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

No dependencies: standard library only, no install step, no network.
