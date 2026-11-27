#pragma once
#include <array>
#include <map>
#include <string>
#include "display_manager.h"

// Wire record: phase (1 down, 2 move, 3 up, 4 cancel, 5 cancel all),
// tool (1 finger, 2 pen, 3 eraser), Android pointer ID, reserved,
// normalized X/Y (0..65535) and pressure (0..1024), all big endian.
class PointerInput {
    struct Contact { POINT point; unsigned tool; unsigned pressure; };
    const DisplayInfo target;
    std::map<unsigned, Contact> contacts;
    HSYNTHETICPOINTERDEVICE touch = nullptr, pen = nullptr;
    ULONGLONG windowStart = 0;
    unsigned windowCount = 0;
    static bool Inject(HSYNTHETICPOINTERDEVICE device, POINTER_TYPE_INFO* frame, UINT32 count) {
        if (InjectSyntheticPointerInput(device, frame, count)) return true;
        if (GetLastError() != ERROR_NOT_READY) return false;
        Sleep(1);
        return InjectSyntheticPointerInput(device, frame, count) != FALSE;
    }
    bool Submit(unsigned changed, POINTER_FLAGS flags) {
        const auto tool = contacts.at(changed).tool;
        auto& device = tool == 1 ? touch : pen;
        if (!device) device = CreateSyntheticPointerDevice(tool == 1 ? PT_TOUCH : PT_PEN, tool == 1 ? 10 : 1, POINTER_FEEDBACK_DEFAULT);
        if (!device) return false;
        std::array<POINTER_TYPE_INFO, 10> frame{};
        UINT32 count = 0;
        for (const auto& [id, c] : contacts) {
            if ((tool == 1) != (c.tool == 1)) continue;
            auto& slot = frame[count++];
            slot.type = tool == 1 ? PT_TOUCH : PT_PEN;
            auto& info = tool == 1 ? slot.touchInfo.pointerInfo : slot.penInfo.pointerInfo;
            info.pointerType = slot.type;
            info.pointerId = id + 1;
            info.ptPixelLocation = c.point;
            info.pointerFlags = id == changed ? flags : POINTER_FLAG_UPDATE;
            if (!(info.pointerFlags & POINTER_FLAG_UP))
                info.pointerFlags |= POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT;
            if (tool == 1) {
                slot.touchInfo.touchMask = TOUCH_MASK_CONTACTAREA;
                slot.touchInfo.rcContact = {c.point.x - 2, c.point.y - 2, c.point.x + 2, c.point.y + 2};
            } else {
                slot.penInfo.penMask = PEN_MASK_PRESSURE;
                slot.penInfo.pressure = (info.pointerFlags & POINTER_FLAG_UP) ? 0 : c.pressure;
                slot.penInfo.penFlags = c.tool == 3 ? PEN_FLAG_ERASER | PEN_FLAG_INVERTED : PEN_FLAG_NONE;
            }
        }
        return Inject(device, frame.data(), count);
    }
public:
    void Cancel() {
        while (!contacts.empty()) {
            auto id = contacts.begin()->first;
            Submit(id, POINTER_FLAG_UP | POINTER_FLAG_CANCELED);
            contacts.erase(id);
        }
    }
    explicit PointerInput(const DisplayInfo& display) : target(display) {}
    ~PointerInput() {
        Cancel();
        if (touch) DestroySyntheticPointerDevice(touch);
        if (pen) DestroySyntheticPointerDevice(pen);
    }
    bool Apply(const unsigned char* p) {
        const auto phase = p[0], tool = p[1], id = p[2];
        if (phase == 5) { Cancel(); return true; }
        if (p[3] || phase < 1 || phase > 4 || tool < 1 || tool > 3 || id > 31) return false;
        if (GetTickCount64() - windowStart >= 1000) { windowStart = GetTickCount64(); windowCount = 0; }
        if (++windowCount > 3000) return false;
        MONITORINFOEXW monitor{};
        monitor.cbSize = sizeof(monitor);
        if (!GetMonitorInfoW(target.hMonitor, &monitor) || target.deviceName != monitor.szDevice ||
            !EqualRect(&target.rect, &monitor.rcMonitor)) return false;
        auto word = [&](int i) -> unsigned { return (unsigned(p[i]) << 8) | p[i+1]; };
        if (word(8) > 1024) return false;
        const RECT& r = monitor.rcMonitor;
        // The synthetic device takes positions relative to the virtual desktop origin.
        Contact next{{r.left - GetSystemMetrics(SM_XVIRTUALSCREEN) + MulDiv(word(4), r.right-r.left-1, 65535),
                      r.top - GetSystemMetrics(SM_YVIRTUALSCREEN) + MulDiv(word(6), r.bottom-r.top-1, 65535)}, tool, word(8)};
        auto found = contacts.find(id);
        if (phase == 1) {
            if (found != contacts.end() || contacts.size() >= 10) return false;
            if (tool != 1 && std::any_of(contacts.begin(), contacts.end(), [](const auto& c){ return c.second.tool != 1; })) return false;
            contacts.emplace(id, next);
            return Submit(id, POINTER_FLAG_DOWN);
        }
        if (found == contacts.end() || found->second.tool != tool) return false;
        if (phase == 2) {
            found->second = next;
            return Submit(id, POINTER_FLAG_UPDATE);
        }
        // Windows requires UP at the previous injected coordinate.
        if (phase == 3 && (next.point.x != found->second.point.x || next.point.y != found->second.point.y)) {
            found->second = next;
            if (!Submit(id, POINTER_FLAG_UPDATE)) return false;
        }
        bool ok = Submit(id, phase == 4 ? POINTER_FLAG_UP | POINTER_FLAG_CANCELED : POINTER_FLAG_UP);
        contacts.erase(id);
        return ok;
    }
};
