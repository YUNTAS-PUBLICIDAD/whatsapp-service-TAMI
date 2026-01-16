export function getPeruDate() {
  return new Date(
    new Date().toLocaleString('en-US', {
      timeZone: 'America/Lima'
    })
  );
}

export function getPeruISOString() {
  return getPeruDate().toISOString();
}

export function getPeruDateTimeFormatted() {
  const date = getPeruDate();

  return {
    fecha: date.toLocaleDateString('es-PE'),
    hora: date.toLocaleTimeString('es-PE', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  };
}
