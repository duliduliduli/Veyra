from dataclasses import asdict, dataclass

from veyra_billing.money import to_nano
from veyra_billing.rates import RateCard

BPS = 10_000


@dataclass(frozen=True)
class ComputeQuote:
    rate_version: str
    resource_class: str
    max_billed_seconds: int
    expected_billed_seconds: int
    supplier_expected_nano: int
    supplier_max_nano: int
    fee_max_nano: int
    customer_expected_nano: int
    customer_max_nano: int  # the hard ceiling the customer authorizes

    def as_dict(self) -> dict:
        return asdict(self)


def compute_cost_nano(rates: RateCard, resource_class: str, seconds: int) -> int:
    """Supplier cost for ``seconds`` of compute, applying the supplier minimum."""
    rc = rates.resource_class(resource_class)
    billed = max(seconds, rates.minimum_billed_seconds)
    per_second = rc.vcpus * rates.vcpu_second + rc.memory_gb * rates.gb_second
    return to_nano(per_second * billed)


def fee_nano(rates: RateCard, supplier_nano: int) -> int:
    # Integer math: ceil(supplier * bps / 10000)
    return -(-supplier_nano * rates.platform_fee_bps // BPS)


def quote_compute(
    rates: RateCard, resource_class: str, expected_runtime_s: int, max_runtime_s: int
) -> ComputeQuote:
    if max_runtime_s <= 0 or expected_runtime_s < 0:
        raise ValueError("runtime bounds must be positive")
    expected_runtime_s = min(expected_runtime_s, max_runtime_s)
    max_billed = max_runtime_s + rates.startup_overhead_seconds
    expected_billed = expected_runtime_s + rates.startup_overhead_seconds
    sup_max = compute_cost_nano(rates, resource_class, max_billed)
    sup_exp = compute_cost_nano(rates, resource_class, expected_billed)
    fee_max = fee_nano(rates, sup_max)
    return ComputeQuote(
        rate_version=rates.version,
        resource_class=resource_class,
        max_billed_seconds=max_billed,
        expected_billed_seconds=expected_billed,
        supplier_expected_nano=sup_exp,
        supplier_max_nano=sup_max,
        fee_max_nano=fee_max,
        customer_expected_nano=sup_exp + fee_nano(rates, sup_exp),
        customer_max_nano=sup_max + fee_max,
    )


@dataclass(frozen=True)
class Settlement:
    supplier_cost_nano: int  # what the platform owes the supplier (always the full actual)
    customer_charge_nano: int  # never exceeds the authorized ceiling
    fee_revenue_nano: int  # 0 when the platform absorbs an overrun
    overrun_absorbed_nano: int  # platform-borne cost beyond the ceiling
    release_nano: int  # unused reservation returned to the customer


def settle_amounts(rates: RateCard, supplier_nano: int, reserved_nano: int) -> Settlement:
    """Settle actual supplier cost against a reservation (spec §15.4/§15.5).

    The customer pays ``min(actual + fee, reserved)``. If infrastructure overran the
    ceiling, the company bears the excess; it is never charged to the customer.
    """
    if supplier_nano < 0 or reserved_nano < 0:
        raise ValueError("amounts must be non-negative")
    full = supplier_nano + fee_nano(rates, supplier_nano)
    charge = min(full, reserved_nano)
    return Settlement(
        supplier_cost_nano=supplier_nano,
        customer_charge_nano=charge,
        fee_revenue_nano=max(charge - supplier_nano, 0),
        overrun_absorbed_nano=max(supplier_nano - charge, 0),
        release_nano=reserved_nano - charge,
    )


def settle_compute(
    rates: RateCard, resource_class: str, billed_seconds: int, reserved_nano: int
) -> Settlement:
    supplier = compute_cost_nano(rates, resource_class, billed_seconds) if billed_seconds > 0 else 0
    return settle_amounts(rates, supplier, reserved_nano)


__all__ = ["ComputeQuote", "Settlement", "compute_cost_nano", "fee_nano", "quote_compute",
           "settle_amounts", "settle_compute"]
