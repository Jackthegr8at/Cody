# Optional Local Hardware Host Helper — Design Only

**Status: not implemented, not packaged, and not shipped.** This is a design for
future local-only hardware access when browser WebUSB/WebSerial cannot provide
a required vendor protocol. It does not relax `lib/devices/hardware-safety.ts`:
every destructive operation still requires a reviewed layout, pre-write backup,
point-of-risk confirmation, and exact post-write readback hash.

## Trust and session model

The helper is a per-user local process, never a network daemon. It listens only
on a user-owned Unix socket / Windows named pipe (with an optional loopback
WebSocket bridge for a browser that cannot access the native socket). It never
accepts LAN traffic, a forwarded port, or a remotely supplied executable path.

1. A signed, versioned Cody release embeds a helper public-key allowlist and a
   helper release embeds the matching Cody grant-verification public key. Both
   keys are rotated with overlapping validity windows and explicit key IDs.
2. An authenticated Cody page creates a fresh Web Crypto signing key and asks
   Cody for a short-lived, signed hardware grant. The grant has a key ID,
   audience, exact HTTPS origin, current Cody session binding, page public-key
   fingerprint, expiry, and a nonce.
3. The helper validates the release signature and grant before it exposes any
   device. It verifies the browser `Origin`, makes the nonce single-use, and
   binds the connection to the page public key. Every later frame is signed by
   that page key and carries the helper session ID and a monotonic sequence.
4. The helper displays a local, native confirmation before it activates a
   grant. The prompt names the local account, Cody origin, device fingerprint,
   requested capability, expiry, and revocation control. Browser approval
   alone is never sufficient.
5. A grant is scoped to one discovered device fingerprint (VID/PID plus serial
   number, USB topology where stable, or serial-path identity), one protocol,
   a small operation set, and an expiry. Navigation, browser disconnect,
   session expiry, device replacement, or sequence failure closes it.

The helper must hold no Cody login cookie, cloud credential, or reusable bearer
token. A stolen helper session cannot be rebound to another page or origin.

## Command boundary

The wire API is typed operations, not a command runner. Each operation carries
an allowlisted vendor tool ID, detected device identity, validated arguments,
and content-addressed input digest. The helper resolves the executable from its
signed bundle by hash; it never searches `PATH`.

Allowed vendor invocations are deliberately narrow, for example: identify a
USB device; retrieve an exact byte range; write one approved range; reset; and
perform a device-specific verified-read command. Each tool ID has a fixed
argument schema and byte limits. Firmware is copied to a private, hash-checked
temporary file; the helper does not accept arbitrary file paths from the page.

There is **no** `exec`, shell, script, command-string, environment override,
working-directory override, glob, redirection, or vendor passthrough API. A
new vendor subcommand requires a reviewed schema, a release, and test coverage;
it cannot be introduced by a page, request option, or helper configuration.

Before a write, the helper independently verifies:

- the page grant permits that exact device and operation;
- the input SHA-256, target, absolute offset, and length match the grant;
- the protocol supplied a materialized backup escrow reference and hash;
- the reviewed protection policy authorizes the requested range; and
- an exact post-write readback method is available.

It presents a second local confirmation immediately before the vendor write.
That prompt includes the device identity, target, absolute offset, length,
firmware SHA-256, backup ID/hash, and any one named protected-region override.
It may not offer an "allow all" option. On success it reads the same range and
compares SHA-256; a transport acknowledgement or delivery CRC is not success.
If readback is unavailable, the helper declines the flash before invoking the
vendor tool.

## Revocation, audit, and recovery

Users can revoke an active grant from the native prompt, tray/menu item, or
Cody device panel. Revocation terminates the connection, deletes private
staging files, and prevents queued work from starting. The helper also revokes
on timeout, device disconnect, backend session invalidation, or identity
mismatch. A process restart begins with no grants.

A local append-only audit record stores timestamp, helper version, Cody origin,
device fingerprint, operation, target, offset, length, image hash, backup hash,
protected override, confirmation result, and verification result. It stores no
firmware bytes or Cody credential. Backup material is saved outside the helper
temp directory with an opaque ID and SHA-256 so it remains available for an
operator-led restore.

## Packaging and privileges

The helper must run unprivileged as the interactive user. Device drivers may
require separate OS-approved installation; the helper never elevates itself or
silently installs a driver.

- **Linux:** signed package with a user systemd service, socket under
  `$XDG_RUNTIME_DIR`, restrictive file permissions, and a bundled-tool manifest
  verified before launch. Distributions may use `.deb`, `.rpm`, or a signed
  portable package, but all must install the same per-user boundary.
- **macOS:** signed and notarized app bundle plus a user LaunchAgent. Native
  IPC uses an entitlement-scoped XPC service or a user-owned socket; USB access
  follows macOS user consent and does not run as a privileged daemon.
- **Windows:** signed MSIX/MSI package with a per-user named pipe ACL restricted
  to the current SID. Vendor executables are bundled as hashed resources; no
  service account, administrator token, or arbitrary process launch is used.

Updates use signed metadata, atomic replacement, and rollback to the prior
verified bundle. A helper update never inherits an active grant.

## UF2 boundary

Generic UF2 is a mass-storage copy convention, not a portable device readback
protocol. Mount identity can change during reset, host-side file hashes prove
only the source file, and a copied UF2 file does not prove the MCU programmed
or retained those bytes. Therefore a generic UF2 target has no `flash`
capability in this design. The helper may prepare a hash-checked UF2 file for
manual copying, but it reports neither a successful flash nor verification.
A future device-specific UF2 workflow may expose flash only when it has an
independent, exact readback channel and follows the same backup/confirmation
rules.

## CMSIS-DAP boundary

CMSIS-DAP/DAPLink transport is potentially feasible through WebUSB with a
maintained DAP.js/DAPLink implementation, but transport discovery is not a
generic flash capability. A safe operation still needs a target-specific flash
algorithm, detected core and memory geometry, immutable protection ranges,
reset/attach sequencing, complete erase-footprint backup and preservation, and
exact post-write readback. Those requirements vary by target and probe firmware;
a generic DAP memory-write command would be an arbitrary destructive primitive.

No CMSIS-DAP support, DAP.js dependency, flash algorithm, probe helper, or
packaging ships in this change. It remains a future device-specific protocol
only after the same intrinsic safety and verification requirements are met.
## Delivery gate

No helper binary, installer, service, vendor executable, trust key, browser
bridge, or elevated capability is included by this design. Implementation may
begin only after the manual hardware checklist has real-device evidence for
the protocol and the security review approves the complete trust and recovery
flow.
