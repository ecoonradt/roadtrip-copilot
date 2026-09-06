"""
Roadtrip Co-Pilot Engine
Loads itinerary.json and calculates:
1. Distance to upcoming waypoints (Haversine formula)
2. Geofenced proximity triggers
3. Ahead/Behind schedule timeline delta
"""

import json
import math
from datetime import datetime, timezone
from pathlib import Path

def haversine_miles(lat1, lon1, lat2, lon2):
    """Calculate the great-circle distance between two points on the Earth in miles."""
    r = 3958.8  # Earth radius in miles
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = math.sin(delta_phi / 2.0) ** 2 + \
        math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c

class RoadtripCoPilot:
    def __init__(self, itinerary_path: str = "itinerary.json"):
        with open(itinerary_path, "r", encoding="utf-8") as f:
            self.data = json.load(f)
        self.visited_checkpoints = set()

    def get_day(self, day_number: int):
        for day in self.data["days"]:
            if day["day"] == day_number:
                return day
        return None

    def evaluate_position(self, day_number: int, current_lat: float, current_lng: float, current_time_str: str = None):
        """
        Evaluates current location against itinerary checkpoints for a given day.
        Returns triggered alerts and schedule status.
        """
        day = self.get_day(day_number)
        if not day:
            return {"error": f"Day {day_number} not found"}

        results = {
            "current_location": {"lat": current_lat, "lng": current_lng},
            "alerts": [],
            "next_checkpoint": None,
            "distance_to_next_miles": None
        }

        closest_checkpoint = None
        closest_distance = float("inf")

        for cp in day["checkpoints"]:
            dist = haversine_miles(current_lat, current_lng, cp["lat"], cp["lng"])
            
            # Check proximity alert trigger
            if dist <= cp["trigger_radius_miles"] and cp["id"] not in self.visited_checkpoints:
                self.visited_checkpoints.add(cp["id"])
                results["alerts"].append({
                    "id": cp["id"],
                    "name": cp["name"],
                    "distance_miles": round(dist, 2),
                    "notification": cp["notification"]
                })

            # Track upcoming waypoint (not yet passed/visited)
            if cp["id"] not in self.visited_checkpoints and dist < closest_distance:
                closest_distance = dist
                closest_checkpoint = cp

        if closest_checkpoint:
            results["next_checkpoint"] = closest_checkpoint["name"]
            results["distance_to_next_miles"] = round(closest_distance, 1)

            # Calculate schedule delta if current_time_str provided (HH:MM:SS)
            if current_time_str:
                target_fmt = "%H:%M:%S"
                try:
                    target_dt = datetime.strptime(closest_checkpoint["target_time"], target_fmt)
                    current_dt = datetime.strptime(current_time_str, target_fmt)
                    delta_minutes = int((target_dt - current_dt).total_seconds() / 60)
                    
                    if delta_minutes > 0:
                        status = f"{delta_minutes} min ahead of schedule"
                    elif delta_minutes < 0:
                        status = f"{abs(delta_minutes)} min behind schedule"
                    else:
                        status = "Exactly on schedule"
                    
                    results["schedule_delta"] = {
                        "target_time": closest_checkpoint["target_time"],
                        "current_time": current_time_str,
                        "delta_minutes": delta_minutes,
                        "status_text": status
                    }
                except ValueError:
                    pass

        return results

    def evaluate_test_position(self, current_lat: float, current_lng: float, elapsed_minutes: float = 0):
        """
        Evaluates position against test_itinerary.json checkpoints.
        """
        checkpoints = self.data.get("checkpoints", [])
        results = {
            "current_location": {"lat": current_lat, "lng": current_lng},
            "alerts": [],
            "next_checkpoint": None,
            "distance_to_next_miles": None
        }

        closest_checkpoint = None
        closest_distance = float("inf")

        for cp in checkpoints:
            dist = haversine_miles(current_lat, current_lng, cp["lat"], cp["lng"])
            radius = cp.get("trigger_radius_miles", 0.5)

            if dist <= radius and cp["id"] not in self.visited_checkpoints:
                self.visited_checkpoints.add(cp["id"])
                results["alerts"].append({
                    "id": cp["id"],
                    "name": cp["name"],
                    "distance_miles": round(dist, 2),
                    "notification": cp["notification"]
                })

            if cp["id"] not in self.visited_checkpoints and dist < closest_distance:
                closest_distance = dist
                closest_checkpoint = cp

        if closest_checkpoint:
            results["next_checkpoint"] = closest_checkpoint["name"]
            results["distance_to_next_miles"] = round(closest_distance, 2)
            target_offset = cp.get("offset_minutes_from_start", 0)
            delta = int(target_offset - elapsed_minutes)
            
            if delta > 1:
                status = f"{delta} min ahead of schedule"
            elif delta < -1:
                status = f"{abs(delta)} min behind schedule"
            else:
                status = "On schedule"

            results["schedule_delta"] = {
                "target_offset_mins": target_offset,
                "elapsed_mins": round(elapsed_minutes, 1),
                "delta_minutes": delta,
                "status_text": status
            }

        return results

if __name__ == "__main__":
    import sys
    if "--test" in sys.argv:
        print("=== Testing Local Drive: Approaching Hudson River / Patroon Island Bridge ===")
        test_copilot = RoadtripCoPilot("test_itinerary.json")
        # Patroon Island Bridge: 42.66517, -73.72953 (simulate 0.4 miles away, 12 mins in)
        status = test_copilot.evaluate_test_position(
            current_lat=42.6680, 
            current_lng=-73.7295, 
            elapsed_minutes=12.0
        )
        print(json.dumps(status, indent=2))
    else:
        copilot = RoadtripCoPilot("itinerary.json")
        print("=== Testing Day 1: Approaching Sedona ===")
        sim_lat = 34.7800
        sim_lng = -111.7645
        status = copilot.evaluate_position(day_number=1, current_lat=sim_lat, current_lng=sim_lng, current_time_str="16:18:00")
        print(json.dumps(status, indent=2))
