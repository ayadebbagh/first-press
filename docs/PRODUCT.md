# Product scope

FIRST PRESS lets underground-music listeners discover artists, commit virtual Credits to artists they believe in, and retain credible evidence of when they backed them. Recognition for early discovery is the core value. The daily rotation is an additional habit, not the foundation of the product.

## Accepted decisions

- Artist-only positions; curated admission with user suggestions.
- 1,000 starting Credits. Credits have no cash value, purchase, transfer or redemption.
- Buy and sell orders queue for the next eligible twice-daily listener update. Pending reservations can be cancelled before execution.
- Positions change proportionally with Spotify monthly listeners. Exact settlement boundaries, precision and outage treatment need a versioned specification before server implementation.
- Spotify embeds for confirmed recordings; SoundCloud only after reviewed Spotify absence. No Audius. Distinct releases retain explicit version labels.
- Next.js, React, TypeScript and pnpm; self-hosted deployment. Bold ink/paper editorial app views, with responsive navigation.

## Existing demo

50 artists and 100 tracks form an editorial shortlist, not a measured popularity chart. 93 Spotify track metadata mappings are checked; seven remain unresolved. Artist listener values are synthetic. Orders, watchlists, requests, votes and receipts live in local storage. Receipt cards are editable demo records, not verified support history. There are no real user accounts or shared community results.

## First connected beta

Authenticated pseudonymous accounts; persistent wallets; server-controlled queued orders and settlement; canonical artist identities; approved, traceable listener snapshots; discovery and saved artists; a small admin catalog/request workflow; receipts with server-verifiable history; a self-hosted deployment with backups and basic operations. Launch invite-only after release gates pass. Artist suggestions do not imply instant admission.

Daily community voting, reputation badges and weekly top-ups are a later milestone. If the daily demo remains accessible, label it illustrative and prevent it from awarding server Credits or verified badges. Public daily functionality requires the provider-use decision to be resolved.

## Deliberately deferred

Song positions, real-money features, direct messaging/comments, native mobile apps, multi-platform blended prices, paid data subscriptions, blockchain, microservices, algorithmic personalized feeds and complex real-time charts. Reconsider only with a specific validated need.

## Success and trust

A new member should understand Credits and the update schedule, discover an artist, place a backing order and recognize the difference between pending and settled support. Returning members should find their portfolio and history useful even when values decline. Measure first settled backing, return visits, saved artists and receipt use; do not optimize only for speculation or wallet size. Pilot targets and event definitions are a decision in the backlog, not fabricated launch metrics.
