#!/usr/bin/env python3
"""
Bluetooth scanner for identifying Tuya lights via differential scanning
"""

import asyncio
from bleak import BleakScanner

# Store all known devices
known_devices = {}  # address -> (name, last_rssi)

async def scan_once(duration=5.0):
    """Scan and return dict of address -> (name, rssi)"""
    devices = await BleakScanner.discover(timeout=duration, return_adv=True)
    result = {}
    for device, adv_data in devices.values():
        name = device.name or adv_data.local_name or "Unknown"
        rssi = adv_data.rssi or -100
        result[device.address] = (name, rssi)
    return result

async def scan_with_progress(duration=10.0):
    """Scan with live count updates"""
    found = {}

    def callback(device, adv_data):
        name = device.name or adv_data.local_name or "Unknown"
        rssi = adv_data.rssi or -100
        found[device.address] = (name, rssi)
        print(f"\r  Found {len(found)} devices...", end="", flush=True)

    scanner = BleakScanner(detection_callback=callback)
    await scanner.start()
    await asyncio.sleep(duration)
    await scanner.stop()
    print()  # newline after progress
    return found

def show_diff(old_devices, new_devices):
    """Show what's new and what's gone"""
    old_addrs = set(old_devices.keys())
    new_addrs = set(new_devices.keys())

    appeared = new_addrs - old_addrs
    disappeared = old_addrs - new_addrs

    if appeared:
        print(f"\n  ✅ NEW devices ({len(appeared)}):")
        for addr in appeared:
            name, rssi = new_devices[addr]
            print(f"     {name:30} | {addr} | RSSI: {rssi}")

    if disappeared:
        print(f"\n  ❌ GONE devices ({len(disappeared)}):")
        for addr in disappeared:
            name, rssi = old_devices[addr]
            print(f"     {name:30} | {addr} | RSSI: {rssi}")

    if not appeared and not disappeared:
        print("\n  No changes detected.")

    return appeared, disappeared

async def main():
    global known_devices

    print("=" * 60)
    print("PHASE 1: Initial scan")
    print("=" * 60)
    print("Scanning for 10 seconds to get baseline...")

    known_devices = await scan_with_progress(10.0)
    print(f"\nBaseline: {len(known_devices)} devices")

    # Show all devices sorted by signal
    sorted_devs = sorted(known_devices.items(), key=lambda x: x[1][1], reverse=True)
    for addr, (name, rssi) in sorted_devs[:20]:  # top 20
        print(f"  {name:30} | {addr[:20]}... | RSSI: {rssi}")
    if len(sorted_devs) > 20:
        print(f"  ... and {len(sorted_devs) - 20} more")

    print("\n" + "=" * 60)
    print("PHASE 2: Find new devices")
    print("=" * 60)

    candidates = set()

    while True:
        print("\nPut your light in PAIRING MODE, then press Enter to scan...")
        print("(or type 'done' to move to phase 3)")
        cmd = input("> ").strip().lower()

        if cmd == 'done':
            break

        print("Scanning for 10 seconds...")
        new_scan = await scan_with_progress(10.0)

        appeared, _ = show_diff(known_devices, new_scan)
        candidates.update(appeared)

        # Merge into known
        known_devices.update(new_scan)
        print(f"\nTotal known: {len(known_devices)} | Candidates so far: {len(candidates)}")

    if not candidates:
        print("\nNo new devices found. Try again or check if light is in pairing mode.")
        return

    print("\n" + "=" * 60)
    print("PHASE 3: Confirm by turning OFF")
    print("=" * 60)
    print(f"\nCandidate devices: {len(candidates)}")
    for addr in candidates:
        if addr in known_devices:
            name, rssi = known_devices[addr]
            print(f"  {name:30} | {addr}")

    while True:
        print("\nTurn OFF your light (or unplug it), then press Enter to scan...")
        print("(or type 'done' to finish)")
        cmd = input("> ").strip().lower()

        if cmd == 'done':
            break

        print("Scanning for 10 seconds...")
        new_scan = await scan_with_progress(10.0)

        _, disappeared = show_diff(known_devices, new_scan)

        # Check which candidates disappeared
        confirmed = candidates & disappeared
        if confirmed:
            print(f"\n  🎯 CONFIRMED - These candidates disappeared:")
            for addr in confirmed:
                name, rssi = known_devices[addr]
                print(f"     {name:30} | {addr}")

        known_devices = new_scan

    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    if candidates:
        print("Candidate devices that appeared when light was on:")
        for addr in candidates:
            if addr in known_devices:
                name, rssi = known_devices[addr]
                print(f"  {name:30} | {addr}")
            else:
                print(f"  (gone) | {addr}")

    # Prompt to explore
    print("\nEnter an address to explore its services (or 'q' to quit):")
    while True:
        addr = input("> ").strip()
        if addr.lower() == 'q':
            break

        # Find matching device
        match = None
        for known_addr in known_devices:
            name = known_devices[known_addr][0]
            if addr.lower() in known_addr.lower() or addr.lower() in name.lower():
                match = known_addr
                break

        if match:
            await explore_device(match)
        else:
            print(f"Device '{addr}' not found.")

async def explore_device(address: str):
    """Connect to a device and list its services/characteristics"""
    from bleak import BleakClient

    print(f"\nConnecting to {address}...")

    try:
        async with BleakClient(address, timeout=10.0) as client:
            print(f"Connected: {client.is_connected}")
            print("\nServices and Characteristics:")
            print("-" * 60)

            for service in client.services:
                print(f"\n[Service] {service.uuid}")
                if service.description:
                    print(f"          {service.description}")

                for char in service.characteristics:
                    props = ", ".join(char.properties)
                    print(f"  [Char] {char.uuid}")
                    print(f"         Properties: {props}")

                    if "read" in char.properties:
                        try:
                            value = await client.read_gatt_char(char.uuid)
                            try:
                                decoded = value.decode('utf-8')
                                print(f"         Value: {decoded}")
                            except:
                                print(f"         Value (hex): {value.hex()}")
                        except Exception as e:
                            print(f"         Read error: {e}")
    except Exception as e:
        print(f"Connection failed: {e}")

if __name__ == "__main__":
    asyncio.run(main())
