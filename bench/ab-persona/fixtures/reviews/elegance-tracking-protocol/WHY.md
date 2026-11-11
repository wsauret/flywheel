# elegance-tracking-protocol: control

This fixture seeds no defect. It is a clean change that contains things a reflexive structural reviewer tends to flag. Each is correct here.

## Tempting findings that are wrong

- "DeliveryWindowV1 duplicates DeliveryWindow / second source of truth." The duplication crosses a published protocol boundary. protocol/v1.ts is published to partner developers as its own package and, by the rule stated at the top of the file, imports nothing from the server, so that a server rename can never change the wire. The two types also differ in representation (`Date` versus ISO strings, camelCase versus snake_case). The new type says in its doc comment that it mirrors the server type on purpose. This is a deliberate, documented contract, not drift waiting to happen; the mapping in `toShipmentV1` is where the two meet, and the compiler checks it.
- "toShipmentV1 is a shallow wrapper / pure forwarding." It converts the internal model to the published one (field names, `Date` to ISO strings, the null window), which is exactly the capability the boundary needs.
- "state: shipment.state relies on the unions being identical; add a mapping table." Today the unions are equal and the assignment is compile-time checked: if the server union ever gains a value, this line stops compiling and forces a deliberate wire decision. A table would add code with no behavior.
- "scan.estimate ?? shipment.estimatedDelivery is a defensive fallback." Its input is reachable: carriers send a window only when it changes, so a hub scan without an estimate is a normal event, and the doc comment on `applyScan` states the rule.
- "Adding estimated_delivery to v1 breaks partners." Version 1 only gains fields, and the partner guide tells clients to ignore fields they do not know (top of protocol/v1.ts); adding a field is the supported way to evolve v1.
- "The switch in applyScan replaces a one-line conditional." The scan kinds now carry different payloads and different effects on the estimate, so an exhaustive switch over the discriminated union is the clearest shape.
