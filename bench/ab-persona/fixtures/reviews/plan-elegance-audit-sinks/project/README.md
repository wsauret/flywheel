# team-console

The admin console of the team workspace product. It ships two ways:

- as a container image for the hosted service, where the platform collects each container's stdout and stderr;
- as an on-premises package that customers run as a system service on their own server, with its data under `DATA_DIR`.

Configuration comes from environment variables only; `src/config.ts` reads them.
