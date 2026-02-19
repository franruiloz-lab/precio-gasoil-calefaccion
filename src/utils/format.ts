export function formatPrice(price: number): string {
  return price.toFixed(3).replace('.', ',');
}

export function formatPriceEur(price: number): string {
  return price.toFixed(2).replace('.', ',') + ' \u20ac';
}

export function formatDate(dateStr: string): string {
  const months = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
  ];
  const [year, month, day] = dateStr.split('-').map(Number);
  return `${day} de ${months[month - 1]} de ${year}`;
}

export function formatMonth(fechaStr: string): string {
  const months = [
    'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
    'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'
  ];
  const [year, month] = fechaStr.split('-').map(Number);
  return `${months[month - 1]} ${year}`;
}

export function getTrendText(variation: number): string {
  if (variation < 0) return `${(variation * 100).toFixed(1).replace('.', ',')} ct`;
  if (variation > 0) return `+${(variation * 100).toFixed(1).replace('.', ',')} ct`;
  return 'Sin cambios';
}

export function getTrendDirection(variation: number): 'up' | 'down' | 'neutral' {
  if (variation < 0) return 'down';
  if (variation > 0) return 'up';
  return 'neutral';
}

export function calculateCost(liters: number, pricePerLiter: number): string {
  return (liters * pricePerLiter).toFixed(2).replace('.', ',');
}

export function getCurrentMonthYear(): string {
  const months = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
  ];
  const now = new Date();
  return `${months[now.getMonth()]} ${now.getFullYear()}`;
}
