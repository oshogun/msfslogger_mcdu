# Sabiá Windows client documentation

This is the documentation set for the Sabiá Windows client: the Tauri
shell, sidecar and CDU panel that read MSFS over SimConnect and uplink to the
Sabiá server. Each page below covers one concern; read [README.md](../README.md)
first for the quick overview, then follow one of the paths below for whatever
you're trying to do.

## Where to start

- **New user, setting the client up for the first time**: [README.md](../README.md)
  → [setup.md](setup.md) → [configuration.md](configuration.md) → [usage.md](usage.md).
- **New contributor, about to change code**: [README.md](../README.md) →
  [setup.md](setup.md) → [architecture.md](architecture.md) →
  [development.md](development.md).
- **Debugging something that's already running**: [troubleshooting.md](troubleshooting.md)
  → [operations.md](operations.md).

## All documents

| Document | Audience | What it answers |
| --- | --- | --- |
| [README.md](../README.md) | Everyone | What this project is, how to build and run it |
| [docs/index.md](index.md) | Everyone | Where to start reading |
| [docs/architecture.md](architecture.md) | Contributors | How the shell, sidecar and CDU panel fit together and talk to each other |
| [docs/setup.md](setup.md) | New users | Prerequisites, first build, first run |
| [docs/configuration.md](configuration.md) | Users, operators | Every config field, the CFG pages, migrating from the old standalone agent |
| [docs/usage.md](usage.md) | Users | Flying with the client: uplink, DATALINK, SimBrief prefile, PDC clearance |
| [docs/cdu-reference.md](cdu-reference.md) | Users, contributors | The page map, LSK layout and full CDU vocabulary |
| [docs/api.md](api.md) | Contributors | The host contract, Tauri commands/events, and the shell↔sidecar protocol |
| [docs/data-model.md](data-model.md) | Contributors | Config schema and the shape of status/datalink messages |
| [docs/operations.md](operations.md) | Operators | Running it day to day: restart behaviour, logs, timeouts |
| [docs/troubleshooting.md](troubleshooting.md) | Users, operators | What a given failure message means and what to do about it |
| [docs/development.md](development.md) | Contributors | Repository layout, dev workflow, checks, branching and PR conventions |
| [docs/release.md](release.md) | Maintainers | Versioning and building the installer |
| [docs/security.md](security.md) | Everyone | Token handling, CSP, and known limitations |
| [docs/glossary.md](glossary.md) | Everyone | What a term used across these docs means |
| [gauge/README.md](../gauge/README.md) | Contributors doing CDU work | Running and using the preview harness |

Every page a documentation spec of this kind expects is present: [api.md](api.md),
[data-model.md](data-model.md), [operations.md](operations.md) and
[release.md](release.md) all exist and each covers only its own concern.
[cdu-reference.md](cdu-reference.md) is an addition beyond that minimum — it
holds the page map, LSK tables and full CDU vocabulary as reference material,
so [usage.md](usage.md) can stay about flows instead of becoming a table
dump.

## Keeping docs current

Update the relevant page in the same change that changes behaviour — a new
config field, a new Tauri command, a new CDU page or failure mode belongs in
its doc before the change is done, not as a follow-up. A doc that contradicts
what the code does is a defect.
