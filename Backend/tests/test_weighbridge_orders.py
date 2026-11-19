import pytest

from services.weighbridge_orders import OrderError, clean_fields


def test_good():
    assert clean_fields(None, " 100 ", "30015", "7") == {
        "order_no": None, "product_code": "100", "quantity_kg": 30015.0, "client_id": 7}
    assert clean_fields("12", "100", 25.5, 7)["order_no"] == 12
    assert clean_fields("", "100", 1, 7)["order_no"] is None


@pytest.mark.parametrize("no", [0, -1, "abc", 1.5, True, "1.5"])
def test_bad_order_no(no):
    with pytest.raises(OrderError):
        clean_fields(no, "100", 10, 7)


@pytest.mark.parametrize("code", ["", None, "   "])
def test_bad_product(code):
    with pytest.raises(OrderError):
        clean_fields(None, code, 10, 7)


@pytest.mark.parametrize("qty", [0, -5, "x", None, True, float("nan"), float("inf")])
def test_bad_quantity(qty):
    with pytest.raises(OrderError):
        clean_fields(None, "100", qty, 7)


@pytest.mark.parametrize("client", [None, "", "x", True])
def test_bad_client(client):
    with pytest.raises(OrderError):
        clean_fields(None, "100", 10, client)
