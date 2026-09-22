"""D-07 SB API collector engine; importing this module performs no native work.

An approved, separately reviewed standalone driver must supply the installed
LLDB Python module, a fresh-fixture ownership recheck, and a bounded nonblocking
record sink. This file does not import LLDB, launch a worker/fixture, accept CLI
commands, or attest OS exits. arm(enabled=True) is an execution guard, NOT user
approval. Do not run it against a live process before D-07 approval.

The driver still owns runtime/worker identity, noninitializing LLDB module
loading, deadlines around blocking native API calls, cancellation delivery,
total output/resource/launch limits, and independently confirmed detach/resume
and fixture/renderer/debugger exits. Native SB calls can outlive a Python timer;
timeout never authorizes a kill. All records are only site/order/thread ordinal.

References: lldb.llvm.org/python_api/lldb.SBDebugger.html (Create(False)),
lldb.SBModule.html (ResolveFileAddress), lldb.SBBreakpoint.html (callbacks/hits),
lldb.SBProcess.html (Stop/Detach), and use/tutorials/breakpoint-triggered-scripts.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import threading
import time
import uuid


RUNTIME = {
    "architecture": "arm64",
    "uuid": "4C4C44A4-5555-3144-A179-5C2625687460",
    "sha256": "965d9ff595733e27add2ae5ce279307aa632d6a707313fc61171c3035bd1aecf",
}
SITES = tuple({"id": name, "address": address, "instructionWord": word} for name, address, word in (
    ("service-check", "0x19ee160", "540015c0"),
    ("service-fallthrough", "0x19ee164", "9102a101"),
    ("payload-check", "0x1e90cb4", "b4007b68"),
    ("payload-fallthrough", "0x1e90cb8", "aa0103fc"),
    ("payload-null", "0x1e91c20", "d2800014"),
    ("result-check", "0x19ee174", "b4001520"),
    ("null-fallback", "0x19ee418", "910fa276"),
    ("result-merge", "0x19ee178", "f9401bf8"),
))
FRAMEWORK = str(Path(__file__).absolute().parent.parent / "node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework")
_ACTIVE = {}
_OWNER_KEYS = {"generation", "rendererPid", "webContentsId", "frameProcessId", "frameRoutingId"}
_ERROR_CODES = frozenset({
    "SB_EVENT_FAILED", "SB_EVENT_LIMIT", "SB_EVENT_PROCESS", "SB_EVENT_STATE",
    "SB_EVENT_SERVICE_PENDING", "SB_EVENT_SERVICE_INCOMPLETE", "SB_DEBUGGER_RETAINED",
    "SB_CALLBACK_OPERATION",
    "SB_ALREADY_USED", "SB_API_FAILED", "SB_ARM_NOT_STOPPED", "SB_ASYNC_REQUIRED",
    "SB_ATTACHMENT_UNKNOWN", "SB_ATTACH_FAILED", "SB_ATTACH_NOT_STOPPED", "SB_BEGIN_NOT_STOPPED",
    "SB_BEGIN_PHASE", "SB_BINDING_CHANGED", "SB_BINDING_INVALID", "SB_BREAKPOINT_INVALID",
    "SB_BUDGET_INVALID", "SB_CALLBACK_ARGUMENTS", "SB_CALLBACK_FAILED", "SB_CALLBACK_PROCESS",
    "SB_CALLBACK_REENTRANT", "SB_CALLBACK_REGISTRATION", "SB_DEADLINE", "SB_DEBUGGER_INVALID",
    "SB_DEBUGGER_SHARED", "SB_DETACH_FAILED", "SB_DETACH_NOT_STOPPED", "SB_DETACH_PHASE",
    "SB_DETACH_UNCONFIRMED", "SB_DISABLED", "SB_FAILED", "SB_FINAL_IDENTITY",
    "SB_FOREIGN_BREAKPOINT", "SB_FRAMEWORK_CHANGED", "SB_FRAMEWORK_HASH", "SB_FRAMEWORK_IDENTITY",
    "SB_FRAMEWORK_INVALID", "SB_HIT_COUNT_MISMATCH", "SB_INPUT_DUPLICATE", "SB_INPUT_INVALID",
    "SB_INPUT_LIMIT", "SB_INSTRUCTION_CHANGED", "SB_INSTRUCTION_MAPPING", "SB_INTERRUPTED",
    "SB_LOADED_MODULE", "SB_LOADED_UUID", "SB_LOCATION_INVALID", "SB_MACHO_COMMAND",
    "SB_MACHO_HEADER", "SB_MACHO_SEGMENT", "SB_MACHO_UUID", "SB_MANIFEST_INVALID",
    "SB_MODULE_LIMIT", "SB_NOT_DRAINED", "SB_NOT_RUNNING", "SB_OPERATION_PENDING",
    "SB_OWNER_CHANGED", "SB_OWNER_INVALID", "SB_PROCESS_CHANGED", "SB_RECORD_LIMIT",
    "SB_RECORD_PHASE", "SB_RECORD_REJECTED", "SB_REMOVE_FAILED", "SB_REMOVE_NOT_STOPPED",
    "SB_REMOVE_RETAINED", "SB_RESUME_FAILED", "SB_SITES_CHANGED", "SB_SITE_INVALID",
    "SB_SITE_UNRESOLVED", "SB_STOP_FAILED", "SB_STOP_STATE", "SB_SYMBOL_SCRIPTS",
    "SB_TARGET_INVALID", "SB_THREAD_INVALID", "SB_THREAD_LIMIT", "SB_UNEXPECTED_STATE",
    "SB_UNEXPECTED_STOP", "SB_UNKNOWN_LOCATION", "SB_UNKNOWN_SITE",
})


class BranchError(Exception):
    """Only fixed, value-free error codes cross the engine boundary."""

    def __init__(self, code):
        self.code = code if type(code) is str and code in _ERROR_CODES else "SB_API_FAILED"
        super().__init__(self.code)


def _require(condition, code):
    if not condition:
        raise BranchError(code)


def _encoded(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True)


def _parse(text):
    _require(type(text) is str and len(text) <= 8192 and len(text.encode("utf8")) <= 8192, "SB_INPUT_LIMIT")
    try:
        def pairs(items):
            result = {}
            for key, value in items:
                _require(key not in result, "SB_INPUT_DUPLICATE")
                result[key] = value
            return result
        return json.loads(text, object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(BranchError("SB_INPUT_INVALID")))
    except BranchError:
        raise
    except Exception:
        raise BranchError("SB_INPUT_INVALID") from None


def _binding(value):
    _require(type(value) is dict and set(value) == {"owner", "nonce"}, "SB_BINDING_INVALID")
    owner = value["owner"]
    _require(type(owner) is dict and set(owner) == _OWNER_KEYS, "SB_OWNER_INVALID")
    _require(all(type(v) is int and (0 if k == "frameRoutingId" else 1) <= v <= 9007199254740991
                 for k, v in owner.items()), "SB_OWNER_INVALID")
    _require(type(value["nonce"]) is str and re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", value["nonce"]), "SB_BINDING_INVALID")
    return value


def verify_framework():
    """Read only the exact pinned regular framework; no memory or symbols read."""
    before = os.lstat(FRAMEWORK)
    _require(stat.S_ISREG(before.st_mode) and before.st_size <= 512 * 1024 * 1024, "SB_FRAMEWORK_INVALID")
    fd = os.open(FRAMEWORK, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as source:
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        _require(identity(os.fstat(source.fileno())) == identity(before), "SB_FRAMEWORK_CHANGED")
        digest = hashlib.sha256()
        count = 0
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            count += len(chunk)
            _require(count <= before.st_size, "SB_FRAMEWORK_CHANGED")
            digest.update(chunk)
        _require(count == before.st_size and digest.hexdigest() == RUNTIME["sha256"], "SB_FRAMEWORK_HASH")
        source.seek(0)
        header = source.read(32)
        _require(len(header) == 32, "SB_MACHO_HEADER")
        magic, cpu, _, _, ncmds, command_bytes, _, _ = struct.unpack("<8I", header)
        _require(magic == 0xfeedfacf and cpu == 0x100000c and 1 <= ncmds <= 4096
                 and ncmds * 8 <= command_bytes <= 1024 * 1024, "SB_MACHO_HEADER")
        commands = source.read(command_bytes)
        _require(len(commands) == command_bytes, "SB_MACHO_HEADER")
        offset = 0
        segments = []
        uuids = []
        for _ in range(ncmds):
            _require(offset + 8 <= len(commands), "SB_MACHO_COMMAND")
            kind, size = struct.unpack_from("<II", commands, offset)
            _require(size >= 8 and size % 8 == 0 and offset + size <= len(commands), "SB_MACHO_COMMAND")
            if kind == 0x19:
                _require(size >= 72, "SB_MACHO_SEGMENT")
                vmaddr, vmsize, fileoff, filesize = struct.unpack_from("<4Q", commands, offset + 24)
                _, initprot = struct.unpack_from("<2I", commands, offset + 56)
                _require(fileoff + filesize <= before.st_size, "SB_MACHO_SEGMENT")
                segments.append((vmaddr, vmsize, fileoff, filesize, initprot))
            elif kind == 0x1b:
                _require(size == 24, "SB_MACHO_UUID")
                uuids.append(str(uuid.UUID(bytes=commands[offset + 8:offset + 24])).upper())
            offset += size
        _require(offset == len(commands) and uuids == [RUNTIME["uuid"]], "SB_MACHO_UUID")
        for site in SITES:
            address = int(site["address"], 16)
            candidates = [s for s in segments if s[0] <= address and address + 4 <= s[0] + min(s[1], s[3]) and s[4] & 4]
            _require(len(candidates) == 1, "SB_INSTRUCTION_MAPPING")
            segment = candidates[0]
            source.seek(segment[2] + address - segment[0])
            data = source.read(4)
            _require(len(data) == 4 and format(struct.unpack("<I", data)[0], "08x") == site["instructionWord"], "SB_INSTRUCTION_CHANGED")
        _require(identity(os.fstat(source.fileno())) == identity(before)
                 and identity(os.lstat(FRAMEWORK)) == identity(before), "SB_FRAMEWORK_CHANGED")
    return dict(RUNTIME)


def branch_hit(frame, location, extra_args, internal_dict):
    """Four-argument callback with SBError-reporting registration; never print."""
    engine = None
    try:
        breakpoint = location.GetBreakpoint()
        engine = _ACTIVE.get(breakpoint.GetTarget().GetDebugger().GetID())
        if engine is None:
            return True
        return engine._hit(frame, location)
    except BaseException:
        if engine is not None:
            engine._fail("SB_CALLBACK_FAILED")
        return True


class StartupBranchLLDB:
    """One-shot collector for one externally verified fixture renderer.

    ownership(binding_json) must synchronously recheck the current fixture/frame
    and exact OS process relationship; a remembered PID is insufficient.
    on_record(record_json) must return True after bounded, lossless admission.
    Methods return JSON engine receipts, not complete coordinator receipts.
    detach does NOT attest process resume observation or debugger OS exit.
    All calls are serialized; cancel() can latch from the driver's other thread.
    Never destroy this engine's debugger while attachment is unconfirmed.
    """

    def __init__(self, lldb, ownership, on_record, *, identity_probe=verify_framework):
        self.api, self.ownership, self.on_record = lldb, ownership, on_record
        self.identity_probe = identity_probe
        self.phase = "new"
        self.binding = None
        self.failure = None
        self.cancelled = threading.Event()
        self.operation = threading.Lock()
        self.records_lock = threading.RLock()
        self.debugger = self.target = self.process = self.module = None
        self.process_uid = None
        self.breakpoints = {}
        self.counts = {}
        self.threads = {}
        self.record_count = self.record_bytes = 0
        self.overflow = False
        self.started = self.drained = self.removed = self.detached = False
        self.in_callback = False
        self.callback_thread = None
        self.service_thread = None
        self.service_start = "not-attempted"
        self.service_fenced = False
        self.service_stop = threading.Event()
        self.service_ready = threading.Event()
        self.service_quiescent = False
        self.stop_requested = False
        self.detaching = False
        self.event_count = 0

    def _fail(self, code):
        self.failure = self.failure or (code if type(code) is str and code in _ERROR_CODES else "SB_API_FAILED")

    def cancel(self):
        self.cancelled.set()
        self._fail("SB_INTERRUPTED")

    def _check(self, until, cleanup=False):
        _require(time.monotonic() <= until, "SB_DEADLINE")
        if not cleanup:
            _require(not self.cancelled.is_set(), "SB_INTERRUPTED")
            _require(self.failure is None, self.failure or "SB_FAILED")

    def _owned(self):
        _require(self.ownership(_encoded(self.binding)) is True, "SB_OWNER_CHANGED")
        if self.process is not None:
            _require(self.process.IsValid() and self.process.GetProcessID() == self.binding["owner"]["rendererPid"]
                     and self.process.GetUniqueID() == self.process_uid, "SB_PROCESS_CHANGED")

    def _error_ok(self, error, code):
        _require(error is not None and error.Success(), code)

    def _call(self, method, serialized, seconds, cleanup=False):
        _require(type(seconds) in (int, float) and 0 < seconds <= (15 if cleanup else 10), "SB_BUDGET_INVALID")
        if self.callback_thread == threading.get_ident():
            self._fail("SB_CALLBACK_OPERATION")
            raise BranchError("SB_CALLBACK_OPERATION")
        until = time.monotonic() + seconds
        acquired = self.operation.acquire(timeout=seconds)
        _require(acquired, "SB_OPERATION_PENDING")
        try:
            self._check(until, cleanup)
            value = _parse(serialized)
            result = method(value, until)
            self._check(until, cleanup)
            return _encoded(result)
        except BranchError as error:
            self._fail(error.code)
            raise BranchError(error.code) from None
        except BaseException:
            self._fail("SB_API_FAILED")
            raise BranchError("SB_API_FAILED") from None
        finally:
            self.operation.release()

    def arm(self, serialized, *, enabled=False, seconds=10):
        _require(enabled is True, "SB_DISABLED")
        return self._call(self._arm, serialized, seconds)

    def _arm(self, request, until):
        _require(self.phase == "new", "SB_ALREADY_USED")
        _require(type(request) is dict and set(request) == {"binding", "runtime", "sites"}
                 and request["runtime"] == RUNTIME and request["sites"] == list(SITES), "SB_MANIFEST_INVALID")
        self.binding = _binding(request["binding"])
        self.phase = "arming"
        self._owned()
        _require(self.identity_probe() == RUNTIME, "SB_FRAMEWORK_IDENTITY")
        self._check(until)
        self.debugger = self.api.SBDebugger.Create(False)
        _require(self.debugger.IsValid(), "SB_DEBUGGER_INVALID")
        name = self.debugger.GetInstanceName()
        self._error_ok(self.api.SBDebugger.SetInternalVariable("target.load-script-from-symbol-file", "false", name), "SB_SYMBOL_SCRIPTS")
        setting = self.api.SBDebugger.GetInternalVariableValue("target.load-script-from-symbol-file", name)
        _require(setting.GetSize() == 1 and setting.GetStringAtIndex(0) == "false", "SB_SYMBOL_SCRIPTS")
        self.debugger.SetAsync(True)
        _require(self.debugger.GetAsync() is True, "SB_ASYNC_REQUIRED")
        self.target = self.debugger.CreateTarget("")
        _require(self.target.IsValid() and self.target.GetNumBreakpoints() == 0, "SB_TARGET_INVALID")
        self._owned()
        self._check(until)
        error = self.api.SBError()
        # Retain the target before attach: partial native failure can still own a
        # process. Recover that exact target's process before any cleanup.
        try:
            self.process = self.target.AttachToProcessWithID(self.debugger.GetListener(), self.binding["owner"]["rendererPid"], error)
        finally:
            candidate = self.target.GetProcess()
            if candidate.IsValid():
                self.process = candidate
                self.process_uid = candidate.GetUniqueID()
        self._error_ok(error, "SB_ATTACH_FAILED")
        self._check(until)
        self._owned()
        _require(self.process.GetState() == self.api.eStateStopped, "SB_ATTACH_NOT_STOPPED")
        module_count = self.target.GetNumModules()
        _require(type(module_count) is int and 1 <= module_count <= 1024, "SB_MODULE_LIMIT")
        matches = []
        for index in range(module_count):
            self._check(until)
            module = self.target.GetModuleAtIndex(index)
            if module.GetUUIDString() == RUNTIME["uuid"]:
                matches.append(module)
        _require(len(matches) == 1, "SB_LOADED_UUID")
        self.module = matches[0]
        file_spec = self.module.GetFileSpec()
        _require(os.path.join(file_spec.GetDirectory(), file_spec.GetFilename()) == FRAMEWORK
                 and self.module.GetTriple().split("-")[0] == "arm64", "SB_LOADED_MODULE")
        debugger_id = self.debugger.GetID()
        _require(debugger_id not in _ACTIVE, "SB_DEBUGGER_SHARED")
        _ACTIVE[debugger_id] = self
        for site in SITES:
            self._check(until)
            address = self.module.ResolveFileAddress(int(site["address"], 16))
            _require(address.IsValid() and address.GetModule() == self.module
                     and address.GetFileAddress() == int(site["address"], 16)
                     and address.GetLoadAddress(self.target) != self.api.LLDB_INVALID_ADDRESS, "SB_SITE_UNRESOLVED")
            bp = self.target.BreakpointCreateBySBAddress(address)
            _require(bp.IsValid() and bp.GetID() not in self.breakpoints, "SB_BREAKPOINT_INVALID")
            self.breakpoints[bp.GetID()] = (site, bp)
            self.counts[site["id"]] = 0
            bp.SetEnabled(True)
            bp.SetOneShot(False)
            bp.SetIgnoreCount(0)
            bp.SetAutoContinue(False)  # Callback False continues; failure True stops.
            args = self.api.SBStructuredData()
            self._error_ok(args.SetFromJSON("{}"), "SB_CALLBACK_ARGUMENTS")
            self._error_ok(bp.SetScriptCallbackFunction(__name__ + ".branch_hit", args), "SB_CALLBACK_REGISTRATION")
        self._sites()
        self._owned()
        _require(self.process.GetState() == self.api.eStateStopped, "SB_ARM_NOT_STOPPED")
        self.phase = "armed"
        return {"binding": self.binding, "runtime": RUNTIME,
                "sites": [dict(site, locations=1, enabled=True) for site in SITES], "engineArmed": True}

    def _sites(self):
        _require(len(self.breakpoints) == 8 and self.target.GetNumBreakpoints() == 8, "SB_SITES_CHANGED")
        for site, bp in self.breakpoints.values():
            _require(bp.IsValid() and bp.IsEnabled() and not bp.IsOneShot() and bp.GetIgnoreCount() == 0
                     and bp.GetNumLocations() == 1, "SB_SITE_INVALID")
            location = bp.GetLocationAtIndex(0)
            _require(location.IsValid() and location.IsEnabled() and location.IsResolved()
                     and location.GetAddress().GetFileAddress() == int(site["address"], 16)
                     and location.GetAddress().GetModule() == self.module, "SB_LOCATION_INVALID")

    def _bound(self, request):
        _require(type(request) is dict and set(request) == {"binding"}
                 and _binding(request["binding"]) == self.binding, "SB_BINDING_CHANGED")

    def begin(self, serialized, *, seconds=5):
        return self._call(self._begin, serialized, seconds)

    def _begin(self, request, until):
        self._bound(request)
        _require(self.phase == "armed", "SB_BEGIN_PHASE")
        self._owned()
        self._sites()
        _require(self.process.GetState() == self.api.eStateStopped, "SB_BEGIN_NOT_STOPPED")
        self.service_thread = threading.Thread(target=self._service_events, name="startup-branch-owned-events", daemon=False)
        self.service_start = "unknown"
        try:
            self.service_thread.start()
        except RuntimeError:
            # CPython Thread.start resource failure precedes scheduling; unlike
            # interruption while waiting for startup, it can establish non-start.
            # Never infer non-start from an absent ident after BaseException.
            if self.service_thread.ident is None and not self.service_thread.is_alive():
                self.service_start = "not-started"
            raise
        self.service_start = "started"
        while not self.service_ready.wait(0.005):
            self._check(until)
            _require(self.service_thread.is_alive(), "SB_EVENT_SERVICE_INCOMPLETE")
        self._check(until)
        self._owned()
        self._sites()
        _require(self.process.GetState() == self.api.eStateStopped, "SB_BEGIN_NOT_STOPPED")
        self.phase = "recording"
        self.started = True
        self._error_ok(self.process.Continue(), "SB_RESUME_FAILED")
        self._wait_state((self.api.eStateRunning, self.api.eStateStepping), until)
        self._owned()
        return {"binding": self.binding, "recording": True, "resumeObservedBySB": True}

    def _consume_event(self):
        event = self.api.SBEvent()
        # GetNextEvent removes the primary listener's event. LLDB runs script
        # callbacks/public-state publication during removal; GetState polling
        # alone does not service them. This call can block in a callback.
        if not self.debugger.GetListener().GetNextEvent(event):
            return False
        self.event_count += 1
        _require(self.event_count <= 4096, "SB_EVENT_LIMIT")
        _require(self.api.SBProcess.EventIsProcessEvent(event), "SB_EVENT_STATE")
        process = self.api.SBProcess.GetProcessFromEvent(event)
        _require(process.IsValid() and process.GetProcessID() == self.binding["owner"]["rendererPid"]
                 and process.GetUniqueID() == self.process_uid, "SB_EVENT_PROCESS")
        state = self.api.SBProcess.GetStateFromEvent(event)
        if state == self.api.eStateStopped:
            # Read restarted AFTER removal: a successful branch callback may
            # have caused auto-resume. Only an actual interruption can account
            # for a cleanup stop; a queued older unexplained stop cannot.
            restarted = self.api.SBProcess.GetRestartedFromEvent(event)
            interrupted = self.api.SBProcess.GetInterruptedFromEvent(event)
            if self.phase not in ("arming", "armed") and not restarted and not (self.stop_requested and interrupted):
                self._fail("SB_UNEXPECTED_STOP")
        elif state == self.api.eStateDetached:
            if not self.detaching:
                self._fail("SB_UNEXPECTED_STATE")
        elif state not in (self.api.eStateRunning, self.api.eStateStepping):
            self._fail("SB_EVENT_STATE")
        return True

    def _service_events(self):
        try:
            while True:
                if self._consume_event():
                    continue
                self.service_ready.set()
                # Stop/Halt may rebroadcast its consumed interruption event.
                # Finish only after the queue is empty following Stop's return.
                if self.service_stop.is_set():
                    self.service_quiescent = True
                    return
                self.service_stop.wait(0.005)
        except BaseException as error:
            self._fail(str(error) if isinstance(error, BranchError) else "SB_EVENT_FAILED")
            self.service_ready.set()

    def _wait_state(self, states, until, cleanup=False, consume=False):
        while self.process.GetState() not in states:
            self._check(until, cleanup)
            if consume:
                self._consume_event()
            else:
                _require(self.service_thread is not None and self.service_thread.is_alive(), "SB_EVENT_SERVICE_INCOMPLETE")
            time.sleep(0.005)
        self._check(until, cleanup)

    def _hit(self, frame, location):
        with self.records_lock:
            if self.in_callback:
                self._fail("SB_CALLBACK_REENTRANT")
                return True
            self.in_callback = True
            self.callback_thread = threading.get_ident()
            try:
                _require(self.phase == "recording" and self.failure is None and not self.cancelled.is_set(), "SB_RECORD_PHASE")
                bp_id = location.GetBreakpoint().GetID()
                _require(bp_id in self.breakpoints, "SB_UNKNOWN_SITE")
                site, bp = self.breakpoints[bp_id]
                _require(location.GetID() == bp.GetLocationAtIndex(0).GetID(), "SB_UNKNOWN_LOCATION")
                thread = frame.GetThread()  # Only identity; never inspect the frame.
                process = thread.GetProcess()
                _require(process.GetProcessID() == self.binding["owner"]["rendererPid"]
                         and process.GetUniqueID() == self.process_uid, "SB_CALLBACK_PROCESS")
                thread_id = thread.GetIndexID()  # LLDB lifetime ordinal avoids OS TID reuse.
                _require(type(thread_id) is int and thread_id > 0, "SB_THREAD_INVALID")
                if thread_id not in self.threads:
                    _require(len(self.threads) < 16, "SB_THREAD_LIMIT")
                    self.threads[thread_id] = len(self.threads) + 1
                record = _encoded({"sequence": self.record_count + 1,
                                   "threadOrdinal": self.threads[thread_id], "site": site["id"]})
                if self.record_count >= 256 or self.record_bytes + len(record) + 1 > 65536:
                    self.overflow = True
                    raise BranchError("SB_RECORD_LIMIT")
                _require(self.on_record(record) is True, "SB_RECORD_REJECTED")
                _require(self.failure is None and not self.cancelled.is_set(), self.failure or "SB_INTERRUPTED")
                self.record_count += 1
                self.record_bytes += len(record) + 1
                self.counts[site["id"]] += 1
                return False
            except BaseException as error:
                self._fail(str(error) if isinstance(error, BranchError) else "SB_CALLBACK_FAILED")
                return True
            finally:
                self.in_callback = False
                self.callback_thread = None

    def stop_and_drain(self, serialized, *, seconds=15):
        return self._call(self._stop, serialized, seconds, True)

    def _fence_service(self, until):
        # Consumer lifetime is independent of SBProcess validity. A vanished
        # process never permits destruction under a pending listener/callback.
        self.service_stop.set()
        thread = self.service_thread
        if thread is None:
            self.service_fenced = True
            return
        if self.service_start == "not-started":
            _require(thread.ident is None and not thread.is_alive(), "SB_EVENT_SERVICE_PENDING")
            self.service_fenced = True
            return
        _require(thread.ident is not None, "SB_EVENT_SERVICE_PENDING")
        thread.join(timeout=max(0, until - time.monotonic()))
        _require(not thread.is_alive(), "SB_EVENT_SERVICE_PENDING")
        self._check(until, True)
        self.service_fenced = True
        # An exited consumer with an undrained queue invalidates observation,
        # but no longer uses the debugger. Safe owned cleanup may still proceed.
        if not self.service_quiescent:
            self._fail("SB_EVENT_SERVICE_INCOMPLETE")

    def _stop(self, request, until):
        self._bound(request)
        self.stop_requested = True
        # Join before reading public stopped state: a callback returning False
        # can still auto-resume after a stale stopped read. Fence even if the
        # process has become invalid or a thread start failed part way through.
        self._fence_service(until)
        if self.process is None or not self.process.IsValid():
            _require(self.target is None or not self.target.GetProcess().IsValid(), "SB_ATTACHMENT_UNKNOWN")
            if self.process is not None:
                self._fail("SB_PROCESS_CHANGED")
            self.drained = True
            self.phase = "drained"
        else:
            self._check(until, True)
            self._owned()
            state = self.process.GetState()
            _require(state in (self.api.eStateStopped, self.api.eStateRunning, self.api.eStateStepping), "SB_UNEXPECTED_STATE")
            if state == self.api.eStateStopped and self.phase == "recording" and self.failure is None:
                self._fail("SB_UNEXPECTED_STOP")
            if state != self.api.eStateStopped:
                self._error_ok(self.process.Stop(), "SB_STOP_FAILED")
                self._wait_state((self.api.eStateStopped,), until, True, consume=True)
            # Halt can rebroadcast an interruption. Drain it locally now that
            # the sole background consumer has joined, then recheck stopped.
            while self._consume_event():
                self._check(until, True)
            _require(self.process.GetState() == self.api.eStateStopped, "SB_STOP_STATE")
            # Stop precedes fencing callbacks; never hold the callback lock while
            # waiting for a native Stop that may need an in-flight callback.
            with self.records_lock:
                self.drained = True
                try:
                    self._sites()
                    for site, bp in self.breakpoints.values():
                        _require(bp.GetHitCount() == self.counts[site["id"]], "SB_HIT_COUNT_MISMATCH")
                except BranchError as error:
                    self._fail(str(error))
                self.phase = "drained"
        return {"binding": self.binding, "quiescent": self.drained,
                "hitCountsReconciled": self.failure is None and self.started,
                "overflow": self.overflow, "recordCount": self.record_count, "failure": self.failure}

    def remove_sites(self, serialized, *, seconds=15):
        return self._call(self._remove, serialized, seconds, True)

    def _remove(self, request, until):
        self._bound(request)
        _require(self.drained, "SB_NOT_DRAINED")
        self._fence_service(until)
        if self.process is not None and self.process.IsValid():
            self._owned()
            _require(self.process.GetState() == self.api.eStateStopped, "SB_REMOVE_NOT_STOPPED")
        if self.target is not None:
            for bp_id in self.breakpoints:
                self._check(until, True)
                bp = self.target.FindBreakpointByID(bp_id)
                if bp.IsValid():
                    _require(self.target.BreakpointDelete(bp_id), "SB_REMOVE_FAILED")
                _require(not self.target.FindBreakpointByID(bp_id).IsValid(), "SB_REMOVE_RETAINED")
            _require(self.target.GetNumBreakpoints() == 0, "SB_FOREIGN_BREAKPOINT")
        self.removed = True
        self.phase = "removed"
        return {"binding": self.binding, "removedSites": [site["id"] for site in SITES], "remaining": 0}

    def detach(self, serialized, *, seconds=15):
        return self._call(self._detach, serialized, seconds, True)

    def _detach(self, request, until):
        self._bound(request)
        _require(self.drained and self.removed and not self.detached, "SB_DETACH_PHASE")
        self._fence_service(until)
        if self.process is not None and self.process.IsValid():
            self._owned()
            _require(self.process.GetState() == self.api.eStateStopped, "SB_DETACH_NOT_STOPPED")
            self.detaching = True
            self._error_ok(self.process.Detach(False), "SB_DETACH_FAILED")
            # The recording service is joined. Service only this terminal
            # transition synchronously; never inspect status strings or frames.
            self._wait_state((self.api.eStateDetached,), until, True, consume=True)
            while self._consume_event():
                self._check(until, True)
        self.detached = True
        self.phase = "detached"
        identity_matches = False
        try:
            identity_matches = self.identity_probe() == RUNTIME
            if not identity_matches:
                self._fail("SB_FINAL_IDENTITY")
        except BaseException:
            self._fail("SB_FINAL_IDENTITY")
        if self.debugger is not None:
            debugger_id = self.debugger.GetID()
            _require(self.service_fenced, "SB_EVENT_SERVICE_PENDING")
            # Destroy requires both owned attachment cleanup and a consumer fence.
            self.api.SBDebugger.Destroy(self.debugger)
            _require(not self.debugger.IsValid(), "SB_DEBUGGER_RETAINED")
            _ACTIVE.pop(debugger_id, None)
        self.phase = "closed"
        self.threads.clear()
        return {"binding": self.binding, "runtime": RUNTIME, "detachedBySB": True,
                "resumeRequested": self.process is not None, "debuggerInstanceDestroyed": True,
                "frameworkReverified": identity_matches, "failure": self.failure,
                "evidenceScope": "sb-api-engine-only", "nativeQualification": False}
