import pytest

from services.temp_silos import (
    TempSiloError, classify, is_temp_silo, plan_manual, plan_trip, same_material,
)


def test_range():
    assert is_temp_silo(1001) and is_temp_silo(1200) and is_temp_silo("1100")
    assert not is_temp_silo(1000) and not is_temp_silo(1201) and not is_temp_silo(102)
    assert not is_temp_silo(None) and not is_temp_silo("abc")


def test_same_material_ignores_leading_zeros():
    assert same_material("012", "12") and same_material(" 100 ", "100")
    assert not same_material("12", "120")


def test_trip_into_free_silo_assigns_material():
    assert plan_trip("", 0, "100", "Corn", 25000) == ("100", "Corn", 25000.0)


def test_trip_adds_and_removes():
    assert plan_trip("100", 25000, "100", "Corn", 5000) == ("100", "Corn", 30000.0)
    assert plan_trip("100", 25000, "100", "Corn", -5000) == ("100", "Corn", 20000.0)


def test_trip_back_to_zero_frees_the_silo():
    assert plan_trip("100", 25000, "100", "Corn", -25000) == ("", "", 0.0)


def test_trip_below_zero_is_kept_with_its_material():
    assert plan_trip("100", 1000, "100", "Corn", -1500) == ("100", "Corn", -500.0)
    assert plan_trip("", 0, "100", "Corn", -1500) == ("100", "Corn", -1500.0)


def test_trip_other_material_is_refused():
    with pytest.raises(TempSiloError):
        plan_trip("100", 25000, "12", "Soya", 1000)
    with pytest.raises(TempSiloError):
        plan_trip("", 0, "", "", 1000)


def test_trip_keeps_the_silos_own_code_spelling():
    assert plan_trip("012", 10, "12", "DL Methionine", 5)[0] == "012"


def test_manual():
    assert plan_manual("100", "Corn", 1234.5) == ("100", "Corn", 1234.5)
    assert plan_manual("100", "Corn", "2000") == ("100", "Corn", 2000.0)
    assert plan_manual("100", "Corn", 0) == ("", "", 0.0)
    assert plan_manual("", "", 0) == ("", "", 0.0)


@pytest.mark.parametrize("code,qty", [("", 10), ("100", -1), ("100", "x"), ("100", None),
                                      ("100", float("nan")), ("100", float("inf"))])
def test_manual_refused(code, qty):
    with pytest.raises(TempSiloError):
        plan_manual(code, "n", qty)


def test_classify():
    rows = [
        {"siloNo": 1001, "materialCode": "100", "materialName": "Corn", "quantityKg": 5.0},
        {"siloNo": 1002, "materialCode": "", "materialName": "", "quantityKg": 0.0},
        {"siloNo": 1003, "materialCode": "012", "materialName": "DL", "quantityKg": 7.0},
    ]
    out = classify(rows, "100")
    assert [s["siloNo"] for s in out["matching"]] == [1001]
    assert [s["siloNo"] for s in out["free"]] == [1002]
    assert [s["siloNo"] for s in classify(rows, "12")["matching"]] == [1003]
