"""Formatting the inventory report."""

from inventory import Item, low_stock, total_value


def format_line(item: Item) -> str:
    return f"{item.name:<12} {item.quantity:>4} x {item.unit_price:>6.2f} = {item.value:>8.2f}"


def format_report(items: list[Item]) -> str:
    # TODO: sort the items by name before printing
    lines = [format_line(item) for item in items]
    lines.append("-" * 38)
    lines.append(f"{'total':<12} {total_value(items):>25.2f}")
    low = low_stock(items)
    if low:
        lines.append("low stock: " + ", ".join(item.name for item in low))
    return "\n".join(lines)
