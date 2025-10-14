import fs from 'fs';
import path from 'path';

// Obtener la ruta del directorio con import.meta.url
const __filename = new URL(import.meta.url).pathname.replace(/^\/+/, '');  // Remueve la barra inicial
const __dirname = path.dirname(__filename);

console.log("Ruta filename:", __filename);
console.log("Ruta dirname:", __dirname);

// Ahora construimos la ruta al archivo bailey-version.json de forma correcta
const baileyVersionPath = path.resolve(__dirname, '../node_modules/@whiskeysockets/baileys/lib/Defaults/baileys-version.json');
console.log("Ruta final:", baileyVersionPath);
const newVersion = [2.3000, 1023223821];  // La versión que necesitas

// Lee el archivo bailey-version.json, modifica la versión y escribe de nuevo
fs.readFile(baileyVersionPath, 'utf8', (err, data) => {
  if (err) {
    console.error("Error leyendo el archivo:", err);
    return;
  }

  const jsonData = JSON.parse(data);
  jsonData.version = newVersion;

  fs.writeFile(baileyVersionPath, JSON.stringify(jsonData, null, 2), 'utf8', (err) => {
    if (err) {
      console.error("Error escribiendo el archivo:", err);
      return;
    }
    console.log("`baileys-version.json` actualizado correctamente.");
  });
});
