from decimal import Decimal

import pytest
from veyra_billing import (
    RATE_CARD_V1,
    compute_cost_nano,
    fee_nano,
    format_usd,
    quote_compute,
    settle_amounts,
    to_nano,
    usd,
)


def test_spec_worked_examples_match_rate_card():
    # Spec §21.3: 4 vCPU / 16 GB for 20 minutes = $0.0776832 (compute only)
    assert usd(compute_cost_nano(RATE_CARD_V1, "standard", 20 * 60)) == Decimal("0.0776832")
    # 1 vCPU / 2 GB, 720 hours = $35.546688
    assert usd(compute_cost_nano(RATE_CARD_V1, "small", 720 * 3600)) == Decimal("35.546688")
    # 32 runs x 8 vCPU / 32 GB x 2h = $29.8303488
    assert usd(32 * compute_cost_nano(RATE_CARD_V1, "large", 7200)) == Decimal("29.8303488")


def test_supplier_minimum_is_applied():
    assert compute_cost_nano(RATE_CARD_V1, "small", 1) == compute_cost_nano(RATE_CARD_V1,
                                                                            "small", 60)


def test_fee_rounds_up_and_is_five_percent():
    assert fee_nano(RATE_CARD_V1, 100) == 5
    assert fee_nano(RATE_CARD_V1, 101) == 6  # ceil, never understate


def test_quote_ceiling_covers_max_runtime_plus_startup():
    q = quote_compute(RATE_CARD_V1, "small", 5, 300)
    assert q.max_billed_seconds == 300 + RATE_CARD_V1.startup_overhead_seconds
    assert q.customer_max_nano == q.supplier_max_nano + q.fee_max_nano
    assert q.customer_expected_nano <= q.customer_max_nano


def test_settlement_never_charges_above_reservation_and_platform_absorbs_overrun():
    s = settle_amounts(RATE_CARD_V1, supplier_nano=1_000, reserved_nano=900)
    assert s.customer_charge_nano == 900
    assert s.overrun_absorbed_nano == 100
    assert s.fee_revenue_nano == 0
    assert s.release_nano == 0


def test_settlement_releases_unused_reservation():
    s = settle_amounts(RATE_CARD_V1, supplier_nano=1_000, reserved_nano=10_000)
    assert s.customer_charge_nano == 1_050
    assert s.release_nano == 10_000 - 1_050
    assert s.customer_charge_nano - s.supplier_cost_nano - s.fee_revenue_nano == 0


def test_floats_are_rejected_for_money():
    with pytest.raises(TypeError):
        to_nano(0.1)  # type: ignore[arg-type]
    assert to_nano("0.1") == 100_000_000
    assert format_usd(to_nano("1234.5")) == "$1,234.50"
