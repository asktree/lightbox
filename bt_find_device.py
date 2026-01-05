#!/usr/bin/env python3
"""
Find a specific Tuya BLE device by MAC address
"""

import asyncio
from bleak import BleakScanner, BleakClient

# Your device's real MAC (from Tuya cloud)
TARGET_MAC = "DC:23:51:2E:E3:43"
TARGET_MAC_CLEAN = TARGET_MAC.replace(":", "").lower()

async def scan_for_device():
    print(f"Scanning for device with MAC {TARGET_MAC}...")
    print("(Looking in names, advertisement data, manufacturer data)\n")

    found_candidates = []

    def detection_callback(device, adv_data):
        name = device.name or adv_data.local_name or ""

        # Check if MAC appears in name
        mac_in_name = TARGET_MAC_CLEAN in name.lower().replace(":", "").replace("-", "").replace("_", "")

        # Check manufacturer data for MAC bytes
        mac_in_mfr = False
        mfr_data_str = ""
        if adv_data.manufacturer_data:
            for company_id, data in adv_data.manufacturer_data.items():
                hex_data = data.hex()
                mfr_data_str = f"[{company_id}]: {hex_data}"
                if TARGET_MAC_CLEAN in hex_data:
                    mac_in_mfr = True
                # Also check reversed byte order
                mac_reversed = "".join(reversed([TARGET_MAC_CLEAN[i:i+2] for i in range(0, 12, 2)]))
                if mac_reversed in hex_data:
                    mac_in_mfr = True

        # Check service data
        mac_in_svc = False
        svc_data_str = ""
        if adv_data.service_data:
            for uuid, data in adv_data.service_data.items():
                hex_data = data.hex()
                svc_data_str = f"{uuid}: {hex_data}"
                if TARGET_MAC_CLEAN in hex_data:
                    mac_in_svc = True

        # Print interesting devices
        is_match = mac_in_name or mac_in_mfr or mac_in_svc
        is_tuya_like = any(x in name.lower() for x in ['ty', 'tuya', 'smart', 'bulb', 'lamp', 'led', 'light'])
        is_unknown_close = name == "" and (adv_data.rssi or -100) > -60

        if is_match or is_tuya_like or is_unknown_close:
            match_str = "🎯 MAC MATCH!" if is_match else ""
            print(f"{match_str}")
            print(f"  Name: {name or '(none)'}")
            print(f"  Address: {device.address}")
            print(f"  RSSI: {adv_data.rssi}")
            if mfr_data_str:
                print(f"  Manufacturer: {mfr_data_str}")
            if svc_data_str:
                print(f"  Service Data: {svc_data_str}")
            if adv_data.service_uuids:
                print(f"  Service UUIDs: {adv_data.service_uuids}")
            print()

            if is_match:
                found_candidates.append((device, adv_data))

    scanner = BleakScanner(detection_callback=detection_callback)

    print("Phase 1: Scanning with light OFF for 10s (establish baseline)...")
    print("-" * 50)
    await scanner.start()
    await asyncio.sleep(10)
    await scanner.stop()

    if found_candidates:
        print(f"\n✅ Found {len(found_candidates)} matching device(s)!")
        return found_candidates[0][0]  # Return first match

    print("\n" + "=" * 50)
    print("No MAC match found in advertisement data.")
    print("This is common - many BLE devices don't advertise their MAC.")
    print("\nLet's try a different approach...")
    print("=" * 50)

    # Try connecting to likely candidates
    return None

async def probe_device(address):
    """Connect and enumerate all services"""
    print(f"\nConnecting to {address}...")

    try:
        async with BleakClient(address, timeout=15.0) as client:
            print(f"✅ Connected!")
            print(f"\nServices and Characteristics:")
            print("=" * 60)

            for service in client.services:
                print(f"\n[Service] {service.uuid}")
                if service.description:
                    print(f"          {service.description}")

                for char in service.characteristics:
                    props = ", ".join(char.properties)
                    print(f"  └─ {char.uuid}")
                    print(f"     Properties: {props}")

                    # Try to read
                    if "read" in char.properties:
                        try:
                            value = await client.read_gatt_char(char.uuid)
                            hex_val = value.hex()
                            try:
                                str_val = value.decode('utf-8', errors='ignore')
                                if str_val.isprintable():
                                    print(f"     Value: {str_val} ({hex_val})")
                                else:
                                    print(f"     Value: {hex_val}")
                            except:
                                print(f"     Value: {hex_val}")
                        except Exception as e:
                            print(f"     Read error: {e}")

            # Look for Tuya-specific characteristics
            print("\n" + "=" * 60)
            print("Looking for Tuya-specific patterns...")

            tuya_uuids = [
                "00002a00-0000-1000-8000-00805f9b34fb",  # Device Name
                "00002a01-0000-1000-8000-00805f9b34fb",  # Appearance
                "0000ff01-0000-1000-8000-00805f9b34fb",  # Tuya custom?
                "0000ff02-0000-1000-8000-00805f9b34fb",  # Tuya custom?
            ]

            for uuid in tuya_uuids:
                try:
                    value = await client.read_gatt_char(uuid)
                    print(f"  {uuid}: {value.hex()}")
                except:
                    pass

    except Exception as e:
        print(f"❌ Connection failed: {e}")

async def main():
    device = await scan_for_device()

    if device:
        await probe_device(device.address)
    else:
        print("\nEnter a device address from the scan to probe (or 'q' to quit):")
        while True:
            addr = input("> ").strip()
            if addr.lower() == 'q':
                break
            await probe_device(addr)

if __name__ == "__main__":
    asyncio.run(main())
