ACROBATE_KEYWORDS = ["acrobat", "acrobate", "acrobatsolution", "safety"]
GAMESTREAM_KEYWORDS = ["gamestream", "game stream", "atlas"]

def detect_company(file_path: str, raw_text: str = "") -> str:
    combined = (file_path + " " + raw_text).lower()

    for kw in GAMESTREAM_KEYWORDS:
        if kw in combined:
            return "GameStream ATLAS"

    for kw in ACROBATE_KEYWORDS:
        if kw in combined:
            return "Acrobate Solution"

    if "gamestream@plane.tn" in combined or "gamestream.formation" in combined:
        return "GameStream ATLAS"
    if "acrobatsolution.com" in combined:
        return "Acrobate Solution"

    return "unknown"
