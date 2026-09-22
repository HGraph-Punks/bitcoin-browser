"""Offline SB collaborator tests. No LLDB import, debugger, or target launch.

Run explicitly with Python 3.9+: python3 -B tests/startup_branch_lldb_test.py
These cases are separate from the Node suite and are NOT native qualification.
"""

import importlib.util
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import sys
import tempfile
import threading
import time
from collections import deque
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).absolute().parent.parent
SPEC = importlib.util.spec_from_file_location("startup_branch_lldb", ROOT / "scripts/startup_branch_lldb.py")
engine_module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = engine_module
SPEC.loader.exec_module(engine_module)
M = engine_module
BINDING = {"owner": {"generation": 1, "rendererPid": 456, "webContentsId": 7,
                      "frameProcessId": 8, "frameRoutingId": 0},
           "nonce": "12345678-1234-4234-8234-123456789abc"}


class Error:
    def __init__(self, good=True): self.good = good
    def Success(self): return self.good


class Invalid:
    def IsValid(self): return False


class Address:
    def __init__(self, module, address): self.module, self.address = module, address
    def IsValid(self): return True
    def GetModule(self): return self.module
    def GetFileAddress(self): return self.address
    def GetLoadAddress(self, target): return self.address + 0x100000000


class Location:
    def __init__(self, bp): self.bp = bp
    def GetBreakpoint(self): return self.bp
    def GetID(self): return 1
    def IsValid(self): return True
    def IsEnabled(self): return self.bp.enabled
    def IsResolved(self): return True
    def GetAddress(self): return self.bp.address


class Breakpoint:
    def __init__(self, target, address, number):
        self.target, self.address, self.number = target, address, number
        self.enabled, self.one_shot, self.ignore = True, False, 0
        self.hits = 0
        self.callback = None
        self.auto_continue = False
    def IsValid(self): return self.number in self.target.bps
    def GetTarget(self): return self.target
    def GetID(self): return self.number
    def SetEnabled(self, value): self.enabled = value
    def SetOneShot(self, value): self.one_shot = value
    def SetIgnoreCount(self, value): self.ignore = value
    def SetAutoContinue(self, value): self.auto_continue = value
    def SetScriptCallbackFunction(self, name, args):
        self.target.api.calls.append(("callback", self.number, name))
        self.callback = name
        return Error(self.number != self.target.api.callback_failure)
    def IsEnabled(self): return self.enabled
    def IsOneShot(self): return self.one_shot
    def GetIgnoreCount(self): return self.ignore
    def GetNumLocations(self): return 1
    def GetLocationAtIndex(self, index): return Location(self)
    def GetHitCount(self): return self.hits


class Module:
    def __init__(self, api): self.api = api
    def GetUUIDString(self): return self.api.loaded_uuid
    def GetTriple(self): return "arm64-apple-macosx"
    def GetFileSpec(self):
        return NS(GetDirectory=lambda: str(Path(M.FRAMEWORK).parent),
                  GetFilename=lambda: Path(M.FRAMEWORK).name)
    def ResolveFileAddress(self, address):
        self.api.calls.append(("resolve", address))
        return Address(self, address)


class Process:
    def __init__(self, api): self.api, self.state, self.uid, self.valid = api, api.eStateStopped, 44, True
    def IsValid(self): return self.valid
    def GetProcessID(self): return 456
    def GetUniqueID(self): return self.uid
    def GetState(self): return self.state
    def Continue(self):
        self.api.calls.append(("continue",))
        self.state = self.api.eStateRunning
        return Error()
    def Stop(self):
        self.api.calls.append(("stop",))
        self.state = self.api.eStateStopped
        return Error()
    def Detach(self, keep_stopped):
        self.api.calls.append(("detach", keep_stopped))
        if self.api.detach_failure: return Error(False)
        self.state = self.api.eStateDetached
        return Error()


class Target:
    def __init__(self, api, debugger):
        self.api, self.debugger, self.bps = api, debugger, {}
        self.process = Invalid()
        self.module = Module(api)
    def IsValid(self): return True
    def GetDebugger(self): return self.debugger
    def GetNumBreakpoints(self): return len(self.bps)
    def GetProcess(self): return self.process
    def AttachToProcessWithID(self, listener, pid, error):
        self.api.calls.append(("attach", pid))
        self.process = Process(self.api)
        if self.api.after_attach: self.api.after_attach()
        if self.api.attach_failure:
            error.good = False
        return self.process
    def GetNumModules(self): return 1
    def GetModuleAtIndex(self, index): return self.module
    def BreakpointCreateBySBAddress(self, address):
        number = len(self.bps) + 1
        bp = Breakpoint(self, address, number)
        self.bps[number] = bp
        self.api.calls.append(("breakpoint", number))
        return bp
    def FindBreakpointByID(self, number): return self.bps.get(number, Invalid())
    def BreakpointDelete(self, number):
        self.api.calls.append(("delete", number))
        if self.api.delete_failure == number: return False
        self.bps.pop(number, None)
        return True


class Debugger:
    def __init__(self, api): self.api, self.async_mode, self.valid = api, False, True
    def IsValid(self): return self.valid
    def GetInstanceName(self): return "synthetic-debugger"
    def GetID(self): return 17
    def SetAsync(self, value): self.async_mode = value
    def GetAsync(self): return self.async_mode
    def CreateTarget(self, name):
        self.api.calls.append(("target", name))
        self.api.target = Target(self.api, self)
        return self.api.target
    def GetListener(self): return self.api.listener


class API:
    eStateStopped, eStateRunning, eStateStepping, eStateDetached = 5, 6, 7, 9
    LLDB_INVALID_ADDRESS = 2 ** 64 - 1
    def __init__(self):
        self.calls = []
        self.setting = "false"
        self.loaded_uuid = M.RUNTIME["uuid"]
        self.callback_failure = self.delete_failure = None
        self.detach_failure = self.attach_failure = False
        self.after_attach = None
        self.target = None
        self.listener = NS(GetNextEvent=lambda event: False)
        self.SBEvent = lambda: NS()
        self.SBProcess = NS(EventIsProcessEvent=lambda event: True,
                            GetProcessFromEvent=lambda event: self.target.process,
                            GetStateFromEvent=lambda event: event.state,
                            GetRestartedFromEvent=lambda event: event.restarted,
                            GetInterruptedFromEvent=lambda event: event.interrupted)
        self.SBError = Error
        self.SBStructuredData = lambda: NS(SetFromJSON=lambda text: Error(text == "{}"))
        self.SBDebugger = NS(Create=self.create, SetInternalVariable=self.setting_set,
                            GetInternalVariableValue=self.setting_get, Destroy=self.destroy)
    def create(self, init):
        self.calls.append(("create", init))
        self.debugger = Debugger(self)
        return self.debugger
    def setting_set(self, key, value, name):
        self.calls.append(("setting", key, value))
        return Error()
    def setting_get(self, key, name): return NS(GetSize=lambda: 1, GetStringAtIndex=lambda i: self.setting)
    def destroy(self, debugger):
        if self.target and self.target.process.IsValid():
            assert self.target.process.state == self.eStateDetached, "must not destroy an attached process"
        self.calls.append(("destroy",))
        debugger.valid = False


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.api = API()
        self.events = []
        self.owner = True
        self.identity_calls = 0
        def identity():
            self.identity_calls += 1
            return dict(M.RUNTIME)
        self.engine = M.StartupBranchLLDB(self.api, lambda binding: self.owner,
                                         lambda record: self.events.append(json.loads(record)) or True,
                                         identity_probe=identity)
        self.request = json.dumps({"binding": BINDING, "runtime": M.RUNTIME, "sites": M.SITES})
        self.bound = json.dumps({"binding": BINDING})
    def tearDown(self):
        # Synthetic registry only. No OS cleanup or process kill is performed.
        if getattr(self.engine, "service_thread", None):
            self.engine.service_stop.set()
            if self.engine.service_thread.ident is not None:
                self.engine.service_thread.join(timeout=1)
            self.assertFalse(self.engine.service_thread.is_alive())
        M._ACTIVE.clear()
    def arm(self): return json.loads(self.engine.arm(self.request, enabled=True))
    def begin(self): self.arm(); return json.loads(self.engine.begin(self.bound))
    def hit(self, index=0, thread=70, process=None):
        bp = self.api.target.bps[index + 1]
        bp.hits += 1
        frame = NS(GetThread=lambda: NS(GetIndexID=lambda: thread,
                                       GetProcess=lambda: process or self.api.target.process))
        return M.branch_hit(frame, Location(bp), None, {})
    def cleanup(self):
        stopped = json.loads(self.engine.stop_and_drain(self.bound))
        removed = json.loads(self.engine.remove_sites(self.bound))
        detached = json.loads(self.engine.detach(self.bound))
        return stopped, removed, detached
    def test_import_construction_and_default_arm_are_inert(self):
        self.assertEqual(self.api.calls, [])
        with self.assertRaisesRegex(M.BranchError, "SB_DISABLED"): self.engine.arm(self.request)
        self.assertEqual(self.api.calls, [])
    def test_full_api_order_and_narrow_receipts(self):
        armed = self.arm()
        self.assertEqual(len(armed["sites"]), 8)
        self.assertNotIn(("continue",), self.api.calls)
        self.assertEqual(self.api.calls[0], ("create", False))
        self.assertLess(self.api.calls.index(("setting", "target.load-script-from-symbol-file", "false")), self.api.calls.index(("attach", 456)))
        self.engine.begin(self.bound)
        for index in (0, 6, 7): self.assertFalse(self.hit(index))
        stopped, removed, detached = self.cleanup()
        self.assertTrue(stopped["hitCountsReconciled"])
        self.assertEqual(stopped["recordCount"], 3)
        self.assertEqual([e["site"] for e in self.events], ["service-check", "null-fallback", "result-merge"])
        self.assertTrue(all(set(e) == {"sequence", "threadOrdinal", "site"} for e in self.events))
        self.assertEqual([e["sequence"] for e in self.events], [1, 2, 3])
        self.assertEqual([e["threadOrdinal"] for e in self.events], [1, 1, 1])
        self.assertEqual(removed["remaining"], 0)
        self.assertLess(self.api.calls.index(("delete", 8)), self.api.calls.index(("detach", False)))
        self.assertLess(self.api.calls.index(("detach", False)), self.api.calls.index(("destroy",)))
        self.assertNotIn("debuggerExited", detached)
        self.assertNotIn("resumed", detached)
        self.assertFalse(detached["nativeQualification"])
        self.assertEqual(self.identity_calls, 2)
    def test_manifest_and_duplicate_json_rejected_before_native_calls(self):
        for text in (self.request.replace("540015c0", "540015c1"), '{"binding":{},"binding":{}}'):
            with self.subTest(text=text[:30]):
                engine = M.StartupBranchLLDB(self.api, lambda _: True, lambda _: True)
                with self.assertRaises(M.BranchError): engine.arm(text, enabled=True)
        self.assertEqual(self.api.calls, [])
    def test_invalid_owner_cannot_attach(self):
        self.owner = False
        with self.assertRaisesRegex(M.BranchError, "SB_OWNER_CHANGED"): self.arm()
        self.assertEqual(self.api.calls, [])
    def test_symbol_script_setting_readback_required(self):
        self.api.setting = "true"
        with self.assertRaisesRegex(M.BranchError, "SB_SYMBOL_SCRIPTS"): self.arm()
        self.assertFalse(any(c[0] == "attach" for c in self.api.calls))
        self.cleanup()
    def test_unknown_loaded_uuid_cannot_arm_and_still_detaches(self):
        self.api.loaded_uuid = "NOT-THE-RUNTIME"
        with self.assertRaisesRegex(M.BranchError, "SB_LOADED_UUID"): self.arm()
        self.assertFalse(any(c[0] == "breakpoint" for c in self.api.calls))
        self.cleanup()
        self.assertIn(("detach", False), self.api.calls)
    def test_partial_callback_registration_failure_removes_exact_created_sites(self):
        self.api.callback_failure = 4
        with self.assertRaisesRegex(M.BranchError, "SB_CALLBACK_REGISTRATION"): self.arm()
        self.cleanup()
        self.assertEqual([c[1] for c in self.api.calls if c[0] == "delete"], [1, 2, 3, 4])
    def test_late_attach_after_cancel_is_retained_for_cleanup(self):
        self.api.after_attach = self.engine.cancel
        with self.assertRaisesRegex(M.BranchError, "SB_INTERRUPTED"): self.arm()
        self.assertTrue(self.api.target.process.IsValid())
        stopped, _, detached = self.cleanup()
        self.assertFalse(stopped["hitCountsReconciled"])
        self.assertTrue(detached["detachedBySB"])
    def test_failed_attach_with_owned_process_is_not_destroyed_early(self):
        self.api.attach_failure = True
        with self.assertRaisesRegex(M.BranchError, "SB_ATTACH_FAILED"): self.arm()
        self.assertNotIn(("destroy",), self.api.calls)
        self.cleanup()
    def test_owner_change_before_continue_prevents_resume(self):
        self.arm()
        self.owner = False
        with self.assertRaisesRegex(M.BranchError, "SB_OWNER_CHANGED"): self.engine.begin(self.bound)
        self.assertNotIn(("continue",), self.api.calls)
    def test_binding_replacement_prevents_continue(self):
        self.arm()
        text = self.bound.replace("12345678", "22345678")
        with self.assertRaisesRegex(M.BranchError, "SB_BINDING_CHANGED"): self.engine.begin(text)
        self.assertNotIn(("continue",), self.api.calls)
    def test_callback_rejects_changed_process_instance(self):
        self.begin()
        other = Process(self.api)
        other.uid += 1
        self.assertTrue(self.hit(process=other))
        self.assertEqual(self.events, [])
        self.assertEqual(self.engine.failure, "SB_CALLBACK_PROCESS")
    def test_site_hit_count_loss_invalidates_whole_capture(self):
        self.begin()
        self.hit()
        self.api.target.bps[2].hits += 1
        stopped, _, _ = self.cleanup()
        self.assertFalse(stopped["hitCountsReconciled"])
        self.assertEqual(stopped["failure"], "SB_HIT_COUNT_MISMATCH")
    def test_disabled_site_invalidates_capture_without_skipping_removal(self):
        self.begin()
        self.api.target.bps[3].enabled = False
        stopped, _, _ = self.cleanup()
        self.assertFalse(stopped["hitCountsReconciled"])
        self.assertEqual(stopped["failure"], "SB_SITE_INVALID")
    def test_events_after_drain_invalidate_previously_good_receipt(self):
        self.begin()
        self.hit()
        first = json.loads(self.engine.stop_and_drain(self.bound))
        self.assertTrue(first["hitCountsReconciled"])
        self.assertTrue(self.hit())
        self.engine.remove_sites(self.bound)
        final = json.loads(self.engine.detach(self.bound))
        self.assertEqual(final["failure"], "SB_RECORD_PHASE")
    def test_thread_ordinals_are_bounded(self):
        self.begin()
        for i in range(16): self.assertFalse(self.hit(thread=1000 + i))
        self.assertTrue(self.hit(thread=9999))
        self.assertEqual(self.engine.failure, "SB_THREAD_LIMIT")
        self.assertEqual([e["threadOrdinal"] for e in self.events], list(range(1, 17)))
    def test_overflow_never_publishes_a_renumbered_suffix(self):
        self.begin()
        for _ in range(256): self.assertFalse(self.hit())
        self.assertTrue(self.hit())
        self.assertEqual(len(self.events), 256)
        self.assertTrue(self.engine.overflow)
        self.assertEqual(self.engine.failure, "SB_RECORD_LIMIT")
    def test_sink_rejection_invalidates_without_admitting_more(self):
        self.begin()
        self.engine.on_record = lambda _: False
        self.assertTrue(self.hit())
        self.assertEqual(self.engine.record_count, 0)
        self.assertEqual(self.engine.failure, "SB_RECORD_REJECTED")
    def test_callback_exception_values_are_not_retained(self):
        self.begin()
        def sink(_): raise M.BranchError("PRIVATE_FIXTURE_VALUE_MUST_NOT_ESCAPE")
        self.engine.on_record = sink
        self.assertTrue(self.hit())
        stopped, _, detached = self.cleanup()
        self.assertNotIn("PRIVATE_FIXTURE", json.dumps([stopped, detached]))
    def test_reentrant_sink_callback_invalidates_instead_of_duplicate_sequence(self):
        self.begin()
        def sink(text):
            self.events.append(json.loads(text))
            if len(self.events) == 1: self.hit(6)
            return True
        self.engine.on_record = sink
        self.hit()
        self.assertIsNotNone(self.engine.failure)
        self.assertLessEqual(len(self.events), 1)
    def test_unexpected_stopped_recording_state_is_not_clean(self):
        self.begin()
        self.api.target.process.state = self.api.eStateStopped
        stopped, _, _ = self.cleanup()
        self.assertFalse(stopped["hitCountsReconciled"])
        self.assertEqual(stopped["failure"], "SB_UNEXPECTED_STOP")
    def test_record_sink_cannot_reenter_cleanup_and_destroy_live_callback(self):
        self.begin()
        def sink(text):
            try:
                self.cleanup()
            except M.BranchError:
                pass
            return True
        self.engine.on_record = sink
        self.assertTrue(self.hit())
        self.assertEqual(self.engine.failure, "SB_CALLBACK_OPERATION")
        self.assertFalse(any(c[0] in ("stop", "delete", "detach", "destroy") for c in self.api.calls))
    def test_failed_removal_does_not_allow_detach_or_destroy(self):
        self.begin()
        self.engine.stop_and_drain(self.bound)
        self.api.delete_failure = 2
        with self.assertRaisesRegex(M.BranchError, "SB_REMOVE_FAILED"): self.engine.remove_sites(self.bound)
        with self.assertRaisesRegex(M.BranchError, "SB_DETACH_PHASE"): self.engine.detach(self.bound)
        self.assertFalse(any(c[0] in ("detach", "destroy") for c in self.api.calls))
    def test_failed_detach_does_not_destroy_debugger(self):
        self.begin()
        self.engine.stop_and_drain(self.bound)
        self.engine.remove_sites(self.bound)
        self.api.detach_failure = True
        with self.assertRaisesRegex(M.BranchError, "SB_DETACH_FAILED"): self.engine.detach(self.bound)
        self.assertNotIn(("destroy",), self.api.calls)
    def test_invalid_process_still_fences_event_consumer_before_destroy(self):
        self.begin()
        self.api.target.process.valid = False
        original = self.api.SBDebugger.Destroy
        def destroy(debugger):
            self.assertFalse(self.engine.service_thread.is_alive(), "event consumer still accesses debugger")
            original(debugger)
        self.api.SBDebugger.Destroy = destroy
        stopped, _, detached = self.cleanup()
        self.assertTrue(stopped["quiescent"])
        self.assertFalse(stopped["hitCountsReconciled"])
        self.assertEqual(stopped["failure"], "SB_PROCESS_CHANGED")
        self.assertTrue(detached["debuggerInstanceDestroyed"])
    def test_thread_start_resource_failure_allows_safe_stopped_arm_cleanup(self):
        self.arm()
        with patch.object(M.threading.Thread, "start", side_effect=RuntimeError("synthetic resource failure")):
            with self.assertRaisesRegex(M.BranchError, "SB_API_FAILED"):
                self.engine.begin(self.bound)
        self.assertNotIn(("continue",), self.api.calls)
        stopped, _, detached = self.cleanup()
        self.assertTrue(stopped["quiescent"])
        self.assertFalse(stopped["hitCountsReconciled"])
        self.assertTrue(detached["debuggerInstanceDestroyed"])
    def test_unknown_thread_start_is_retained_until_actual_start_and_join(self):
        self.arm()
        with patch.object(M.threading.Thread, "start", side_effect=KeyboardInterrupt()):
            with self.assertRaises(M.BranchError): self.engine.begin(self.bound)
        try:
            with self.assertRaisesRegex(M.BranchError, "SB_EVENT_SERVICE_PENDING"):
                self.engine.stop_and_drain(self.bound, seconds=0.01)
            with self.assertRaises(M.BranchError): self.engine.remove_sites(self.bound)
            self.assertFalse(any(c[0] in ("delete", "detach", "destroy") for c in self.api.calls))
        finally:
            # Resolve the deliberately unknown synthetic start. This is an
            # ordinary Python thread, with no native LLDB or target process.
            self.engine.service_thread.start()
        stopped, _, detached = self.cleanup()
        self.assertFalse(self.engine.service_thread.is_alive())
        self.assertFalse(stopped["hitCountsReconciled"])
        self.assertTrue(detached["debuggerInstanceDestroyed"])
    def test_runtime_error_after_actual_start_still_requires_join(self):
        self.arm()
        original = M.threading.Thread.start
        def start_then_fail(thread):
            original(thread)
            raise RuntimeError("synthetic failure after scheduling")
        with patch.object(M.threading.Thread, "start", start_then_fail):
            with self.assertRaises(M.BranchError): self.engine.begin(self.bound)
        self.assertIsNotNone(self.engine.service_thread.ident)
        self.assertNotIn(("continue",), self.api.calls)
        stopped, _, detached = self.cleanup()
        self.assertFalse(self.engine.service_thread.is_alive())
        self.assertFalse(stopped["hitCountsReconciled"])
        self.assertTrue(detached["debuggerInstanceDestroyed"])
    def test_event_consumer_failure_stays_invalid_but_can_clean_owned_stopped_arm(self):
        self.arm()
        def fail_listener(event): raise RuntimeError("synthetic bounded listener failure")
        self.api.listener.GetNextEvent = fail_listener
        with self.assertRaisesRegex(M.BranchError, "SB_EVENT_FAILED"):
            self.engine.begin(self.bound)
        self.api.listener.GetNextEvent = lambda event: False
        stopped, _, detached = self.cleanup()
        self.assertFalse(self.engine.service_thread.is_alive())
        self.assertFalse(stopped["hitCountsReconciled"])
        self.assertEqual(stopped["failure"], "SB_EVENT_FAILED")
        self.assertTrue(detached["debuggerInstanceDestroyed"])
    def test_final_identity_failure_is_reported_after_safe_detach(self):
        self.begin()
        self.engine.identity_probe = lambda: {}
        _, _, final = self.cleanup()
        self.assertFalse(final["frameworkReverified"])
        self.assertEqual(final["failure"], "SB_FINAL_IDENTITY")
        self.assertIn(("destroy",), self.api.calls)
    def test_synchronous_preflight_deadline_prevents_attach(self):
        def slow(): time.sleep(0.01); return dict(M.RUNTIME)
        self.engine.identity_probe = slow
        with self.assertRaisesRegex(M.BranchError, "SB_DEADLINE"):
            self.engine.arm(self.request, enabled=True, seconds=0.001)
        self.assertEqual(self.api.calls, [])
    def test_python_manifest_matches_frozen_javascript_manifest(self):
        javascript = (ROOT / "scripts/startup-branch-evidence.mjs").read_text()
        self.assertIn(M.RUNTIME["uuid"], javascript)
        self.assertIn(M.RUNTIME["sha256"], javascript)
        found = re.findall(r"\['([^']+)', '(0x[0-9a-f]+)', '([0-9a-f]{8})'\]", javascript)
        self.assertEqual(found, [(s["id"], s["address"], s["instructionWord"]) for s in M.SITES])


class FrameworkTests(unittest.TestCase):
    def fixture(self):
        commands = []
        offset = 32 + 8 * 72 + 24
        for index, site in enumerate(M.SITES):
            commands.append(struct.pack("<II16s4Q4I", 0x19, 72, b"__TEXT", int(site["address"], 16),
                                        4, offset + index * 4, 4, 5, 5, 0, 0))
        commands.append(struct.pack("<II", 0x1b, 24) + uuid.UUID(M.RUNTIME["uuid"]).bytes)
        header = struct.pack("<8I", 0xfeedfacf, 0x100000c, 0, 6, 9, 8 * 72 + 24, 0, 0)
        return header + b"".join(commands) + b"".join(struct.pack("<I", int(s["instructionWord"], 16)) for s in M.SITES)
    def check_bytes(self, data):
        with tempfile.TemporaryDirectory(prefix="startup-branch-python-fixture-") as directory:
            filename = Path(directory) / "synthetic-framework"
            filename.write_bytes(data)
            runtime = dict(M.RUNTIME, sha256=hashlib.sha256(data).hexdigest())
            with patch.object(M, "FRAMEWORK", str(filename)), patch.object(M, "RUNTIME", runtime):
                return M.verify_framework()
    def test_actual_file_header_uuid_and_instruction_mapping(self):
        self.assertEqual(self.check_bytes(self.fixture())["uuid"], M.RUNTIME["uuid"])
    def test_changed_instruction_fails_even_with_matching_fixture_hash(self):
        data = self.fixture()
        with self.assertRaisesRegex(M.BranchError, "SB_INSTRUCTION_CHANGED"): self.check_bytes(data[:-1] + b"\xff")
    def test_non_executable_segment_is_not_valid_instruction_mapping(self):
        data = bytearray(self.fixture())
        struct.pack_into("<I", data, 32 + 60, 1)
        with self.assertRaisesRegex(M.BranchError, "SB_INSTRUCTION_MAPPING"): self.check_bytes(data)
    def test_malformed_command_bound_is_rejected(self):
        data = bytearray(self.fixture())
        struct.pack_into("<I", data, 36, 2 ** 31)
        with self.assertRaisesRegex(M.BranchError, "SB_MACHO_COMMAND"): self.check_bytes(data)


class QueuedProcess(Process):
    def Continue(self):
        self.api.calls.append(("continue",))
        self.api.queue.append((self.api.eStateRunning, None, False))
        return Error()
    def Stop(self):
        self.api.calls.append(("stop",))
        self.api.queue.append((self.api.eStateStopped, None, True))
        return Error()
    def Detach(self, keep_stopped):
        self.api.calls.append(("detach", keep_stopped))
        self.api.queue.append((self.api.eStateDetached, None, False))
        return Error()


class QueuedAPI(API):
    def __init__(self):
        super().__init__()
        self.queue = deque()
        self.after_callback = None
        self.listener = NS(GetNextEvent=self.next_event)
        self.after_attach = lambda: setattr(self.target, "process", QueuedProcess(self))
    def next_event(self, event):
        if not self.queue: return False
        state, action, interrupted = self.queue.popleft()
        event.state, event.restarted, event.interrupted = state, False, interrupted
        self.target.process.state = state
        if action:
            # LLDB invokes script callbacks while removing the public event.
            event.restarted = action() is False
            if self.after_callback: self.after_callback()
            if event.restarted: self.target.process.state = self.eStateRunning
        self.calls.append(("consumed", state, event.restarted, interrupted))
        return True


class EventServiceTests(unittest.TestCase):
    def setUp(self):
        self.api, self.events = QueuedAPI(), []
        self.engine = M.StartupBranchLLDB(self.api, lambda _: True,
                                         lambda text: self.events.append(json.loads(text)) or True,
                                         identity_probe=lambda: dict(M.RUNTIME))
        self.request = json.dumps({"binding": BINDING, "runtime": M.RUNTIME, "sites": M.SITES})
        self.bound = json.dumps({"binding": BINDING})
        self.release = threading.Event()
    def tearDown(self):
        self.release.set()
        if getattr(self.engine, "service_thread", None):
            self.engine.service_stop.set()
            self.engine.service_thread.join(timeout=1)
            self.assertFalse(self.engine.service_thread.is_alive())
        M._ACTIVE.clear()
    def begin(self):
        self.engine.arm(self.request, enabled=True)
        self.engine.begin(self.bound, seconds=0.5)
    def callback(self, index):
        bp = self.api.target.bps[index]
        def action():
            bp.hits += 1
            frame = NS(GetThread=lambda: NS(GetIndexID=lambda: 70, GetProcess=lambda: self.api.target.process))
            return M.branch_hit(frame, Location(bp), None, {})
        self.api.queue.append((self.api.eStateStopped, action, False))
    def wait_for(self, predicate):
        until = time.monotonic() + 0.5
        while not predicate() and time.monotonic() < until: time.sleep(0.005)
        self.assertTrue(predicate())
    def finish(self):
        stopped = json.loads(self.engine.stop_and_drain(self.bound, seconds=0.5))
        self.engine.remove_sites(self.bound, seconds=0.5)
        detached = json.loads(self.engine.detach(self.bound, seconds=0.5))
        return stopped, detached
    def test_callbacks_and_public_state_need_owned_event_consumption(self):
        self.begin()
        for index in (1, 7, 8): self.callback(index)
        self.wait_for(lambda: len(self.events) == 3)
        stopped, detached = self.finish()
        self.assertTrue(stopped["hitCountsReconciled"])
        self.assertTrue(detached["detachedBySB"])
        self.assertEqual([e["sequence"] for e in self.events], [1, 2, 3])
        self.assertTrue(any(c[:2] == ("consumed", self.api.eStateStopped) and c[3] for c in self.api.calls))
        self.assertFalse(self.engine.service_thread.is_alive())
    def test_old_unexplained_stop_cannot_be_accepted_as_cleanup_interrupt(self):
        self.begin()
        self.api.queue.append((self.api.eStateStopped, None, False))
        stopped, _ = self.finish()
        self.assertFalse(stopped["hitCountsReconciled"])
        self.assertEqual(stopped["failure"], "SB_UNEXPECTED_STOP")
    def test_pending_callback_prevents_removal_detach_or_destroy(self):
        self.begin()
        entered = threading.Event()
        def sink(text):
            entered.set()
            self.release.wait(1)
            return True
        self.engine.on_record = sink
        self.callback(1)
        self.assertTrue(entered.wait(0.5))
        with self.assertRaises(M.BranchError): self.engine.stop_and_drain(self.bound, seconds=0.02)
        with self.assertRaises(M.BranchError): self.engine.remove_sites(self.bound, seconds=0.02)
        self.assertFalse(any(c[0] in ("delete", "detach", "destroy") for c in self.api.calls))
        self.release.set()
        self.wait_for(lambda: not self.engine.in_callback)
        stopped, _ = self.finish()
        self.assertFalse(stopped["hitCountsReconciled"])
    def test_cleanup_during_valid_callback_waits_then_stops_resumed_target(self):
        self.begin()
        entered = threading.Event()
        def sink(text):
            self.events.append(json.loads(text))
            entered.set()
            self.release.wait(1)
            return True
        self.engine.on_record = sink
        self.callback(1)
        self.assertTrue(entered.wait(0.5))
        result = []
        def stopping():
            try: result.append(json.loads(self.engine.stop_and_drain(self.bound, seconds=0.5)))
            except BaseException as error: result.append(error)
        worker = threading.Thread(target=stopping)
        worker.start()
        time.sleep(0.01)
        self.release.set()
        worker.join(timeout=1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(result), 1)
        self.assertIsInstance(result[0], dict)
        self.assertTrue(result[0]["hitCountsReconciled"])
        self.assertTrue(result[0]["quiescent"])
        self.assertEqual(self.api.target.process.GetState(), self.api.eStateStopped)
        self.engine.remove_sites(self.bound)
        self.engine.detach(self.bound)
    def test_owner_change_during_initial_listener_drain_cannot_resume(self):
        changed = threading.Event()
        self.engine.ownership = lambda _: not changed.is_set()
        original = self.api.listener.GetNextEvent
        def initial(event):
            changed.set()
            return original(event)
        self.api.listener.GetNextEvent = initial
        self.engine.arm(self.request, enabled=True)
        with self.assertRaisesRegex(M.BranchError, "SB_OWNER_CHANGED"):
            self.engine.begin(self.bound, seconds=0.5)
        self.assertNotIn(("continue",), self.api.calls)
    def test_callback_return_window_cannot_claim_quiescent_running_target(self):
        self.begin()
        returned = threading.Event()
        def after_callback():
            returned.set()
            self.release.wait(1)
        self.api.after_callback = after_callback
        self.callback(1)
        self.assertTrue(returned.wait(0.5))
        result = []
        def stopping():
            try: result.append(json.loads(self.engine.stop_and_drain(self.bound, seconds=0.5)))
            except BaseException as error: result.append(error)
        worker = threading.Thread(target=stopping)
        worker.start()
        time.sleep(0.01)
        self.release.set()
        worker.join(timeout=1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(result), 1)
        self.assertIsInstance(result[0], dict)
        self.assertFalse(result[0]["quiescent"] and self.api.target.process.GetState() != self.api.eStateStopped)
    def test_invalid_process_with_pending_callback_cannot_remove_or_destroy(self):
        self.begin()
        entered = threading.Event()
        def sink(text):
            entered.set()
            self.release.wait(1)
            return True
        self.engine.on_record = sink
        self.callback(1)
        self.assertTrue(entered.wait(0.5))
        self.api.target.process.valid = False
        with self.assertRaisesRegex(M.BranchError, "SB_EVENT_SERVICE_PENDING"):
            self.engine.stop_and_drain(self.bound, seconds=0.02)
        with self.assertRaises(M.BranchError): self.engine.remove_sites(self.bound)
        with self.assertRaises(M.BranchError): self.engine.detach(self.bound)
        self.assertFalse(any(c[0] in ("delete", "detach", "destroy") for c in self.api.calls))
        self.release.set()
        self.wait_for(lambda: not self.engine.service_thread.is_alive())
        stopped, detached = self.finish()
        self.assertFalse(stopped["hitCountsReconciled"])
        self.assertTrue(detached["debuggerInstanceDestroyed"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
