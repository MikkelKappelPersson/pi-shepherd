# Intent — 012 steer default

Parent→child and peer messages that omit `delivery` currently arrive
as `followUp` (queue passively). Observed live (011 Track C): a
followUp request to an idle hc child sat queued for minutes; the
steer retry completed promptly. Sheep are task-driven — a message to
one is almost always actionable — so the passive default is
backwards. Child→parent already upgrades wake-deserving messages to
steer (`parentMessageDeliveryOptions`); this aligns the other
direction. Every intentionally-passive internal sender (nudges,
stale bridges, herdr task publish) already passes explicit
`followUp`, so only agent-authored messages change behavior.
