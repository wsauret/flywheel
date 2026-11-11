# Task board architecture

The board has three layers. Dependencies point one way: `ui` and `storage` depend on `domain`; `domain` depends on nothing else in `src/`.

- `src/domain/`: board rules. Every rule about what a board may contain and which moves are legal lives here, so the web client, the import job, and the API all enforce the same rules.
- `src/storage/`: persistence of boards.
- `src/ui/`: text rendering of boards for the terminal client.
