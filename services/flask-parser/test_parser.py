#!/usr/bin/env python3
"""
Test script for the optimized invoice parser v2.
Validates that all parsers can be imported and basic functions work.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def test_imports():
    """Test that all parser modules can be imported."""
    print("Testing imports...")
    try:
        from parser import constants, utils, confidence, payload_builder
        print("✓ Core imports successful (parsers skipped - need openpyxl/pdfplumber)")
        return True
    except ImportError as e:
        print(f"✗ Import failed: {e}")
        return False

def test_constants():
    """Test that constants are properly defined."""
    print("\nTesting constants...")
    from parser.constants import LABEL_BLOCKLIST, INVOICE_LABELS, DATE_LABELS
    assert len(LABEL_BLOCKLIST) > 50, "LABEL_BLOCKLIST should have 50+ entries"
    assert len(INVOICE_LABELS) > 3, "INVOICE_LABELS should have multiple entries"
    assert len(DATE_LABELS) > 2, "DATE_LABELS should have multiple entries"
    print(f"✓ Constants defined: {len(LABEL_BLOCKLIST)} blocked labels")
    return True

def test_utils():
    """Test utility functions."""
    print("\nTesting utils...")
    from parser.utils import is_label, parse_number, normalize_date

    # Test label detection
    assert is_label("Nom") == True
    assert is_label("Total TTC") == True
    assert is_label("Client") == True
    # Real values with numbers or longer than 25 chars should not be labels
    assert is_label("Acrobate Solutions SARL - Ariana, Tunisia 2027") == False
    assert is_label("2024-001") == False

    # Test number parsing (European format: space/dot=thousands, comma=decimal)
    assert abs(parse_number("1 234,56") - 1234.56) < 0.01
    assert abs(parse_number("1.234,56") - 1234.56) < 0.01
    assert abs(parse_number("1234.56") - 1234.56) < 0.01  # Simple decimal
    assert abs(parse_number("1234,56") - 1234.56) < 0.01  # European decimal

    # Test date normalization
    assert normalize_date("15/03/2024") == "2024-03-15"
    assert normalize_date("2024-03-15") == "2024-03-15"

    print("✓ Utils functions working correctly")
    return True

def test_confidence():
    """Test confidence scoring."""
    print("\nTesting confidence...")
    from parser.confidence import score_confidence

    # Full data should give high confidence
    score = score_confidence("2024-001", "15/03/2024", "1234.56", "Société Exemple SARL")
    assert score >= 0.85, f"Full data should score high: {score}"

    # Missing data should give low confidence
    score = score_confidence(None, None, None, None)
    assert score == 0.0, f"No data should score 0: {score}"

    # Labels should not count
    score = score_confidence("Nom", "Date", "Total", "Client")
    assert score == 0.0, f"Labels should score 0: {score}"

    print(f"✓ Confidence scoring working correctly")
    return True

def test_payload_builder():
    """Test payload construction."""
    print("\nTesting payload builder...")
    from parser.payload_builder import build_payload

    payload = build_payload(
        invoice_no="2024-001",
        date_raw="15/03/2024",
        total_raw="1234.56",
        client="Société Exemple SARL",
        vat_raw="234.56",
        ht_raw="1000.00",
        items=[{"description": "Service", "quantity": 1, "unitPrice": 1000}],
        source_path="/test/invoice.xlsx",
        extraction_method="test"
    )

    assert payload["invoiceNo"] == "2024-001"
    assert payload["date"] == "2024-03-15"
    assert payload["totalAmount"] == 1234.56
    assert payload["metadata"]["clientName"] == "Société Exemple SARL"
    assert payload["metadata"]["confidence"] >= 0.85  # Should be high with good data

    print("✓ Payload builder working correctly")
    return True

def test_company_detection():
    """Test company detection from path."""
    print("\nTesting company detection...")
    from parser.utils import detect_company

    assert detect_company("/invoices/ACROBATE_2024.xlsx") == "ACROBATE_SOLUTION"
    assert detect_company("/invoices/GAMESTREAM_2024.pdf") == "GAMESTREAM_ATLAS"
    assert detect_company("/invoices/ATLAS_2024.csv") == "GAMESTREAM_ATLAS"
    assert detect_company("/invoices/other_2024.xlsx") == "UNKNOWN"

    print("✓ Company detection working correctly")
    return True

def test_currency_detection():
    """Test currency detection."""
    print("\nTesting currency detection...")
    from parser.utils import detect_currency

    assert detect_currency("Total: 100 DT") == "TND"
    assert detect_currency("Total: 100 €") == "EUR"
    assert detect_currency("", "/invoices/TND_invoice.pdf") == "TND"
    assert detect_currency("", "/invoices/invoice.pdf") == "EUR"

    print("✓ Currency detection working correctly")
    return True

def main():
    """Run all tests."""
    print("=" * 60)
    print("INVOICE PARSER V2 - TEST SUITE")
    print("=" * 60)

    tests = [
        test_imports,
        test_constants,
        test_utils,
        test_confidence,
        test_payload_builder,
        test_company_detection,
        test_currency_detection,
    ]

    passed = 0
    failed = 0

    for test in tests:
        try:
            if test():
                passed += 1
            else:
                failed += 1
        except Exception as e:
            print(f"✗ {test.__name__} failed with exception: {e}")
            import traceback
            traceback.print_exc()
            failed += 1

    print("\n" + "=" * 60)
    print(f"RESULTS: {passed} passed, {failed} failed")
    print("=" * 60)

    if failed == 0:
        print("✓ ALL TESTS PASSED!")
        return 0
    else:
        print("✗ SOME TESTS FAILED")
        return 1

if __name__ == "__main__":
    sys.exit(main())
