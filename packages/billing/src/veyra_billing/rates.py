from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class ResourceClass:
    name: str
    vcpus: Decimal
    memory_gb: Decimal


@dataclass(frozen=True)
class RateCard:
    """A versioned, immutable supplier rate card.

    Rates are published AWS Fargate Linux/x86 us-east-1 observations (spec §21.1, S13).
    A price change is a *new version*; historical quotes keep the version they used.
    """

    version: str
    supplier: str
    region: str
    vcpu_second: Decimal
    gb_second: Decimal
    minimum_billed_seconds: int
    startup_overhead_seconds: int
    platform_fee_bps: int
    resource_classes: dict[str, ResourceClass]
    source: str
    retrieved: str

    def resource_class(self, name: str) -> ResourceClass:
        try:
            return self.resource_classes[name]
        except KeyError:
            raise ValueError(f"unknown resource class {name!r}") from None


RATE_CARD_V1 = RateCard(
    version="fargate-use1-2026-10-11",
    supplier="aws-fargate",
    region="us-east-1",
    vcpu_second=Decimal("0.000011244"),
    gb_second=Decimal("0.000001235"),
    minimum_billed_seconds=60,
    # Image pull + task provisioning is billed by Fargate; budget for it explicitly.
    startup_overhead_seconds=30,
    platform_fee_bps=500,  # proposed 5% (spec §1.3) - NOT approved pricing
    resource_classes={
        "small": ResourceClass("small", Decimal("1"), Decimal("2")),
        "standard": ResourceClass("standard", Decimal("4"), Decimal("16")),
        "large": ResourceClass("large", Decimal("8"), Decimal("32")),
    },
    source="https://aws.amazon.com/fargate/pricing/",
    retrieved="2026-10-11",
)
