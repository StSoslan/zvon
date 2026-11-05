# DeepFilterNet3

Файлы нейросетевого шумоподавления [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet)
(Hendrik Schröter и соавторы), лицензия MIT / Apache-2.0:

- `df_bg.wasm` — библиотека libDF, собранная в WebAssembly (wasm-bindgen);
- `DeepFilterNet3_onnx.tar.gz` — веса модели DeepFilterNet3.

Оба файла взяты без изменений из npm-пакета
[`@workadventure/noise-suppression`](https://github.com/workadventure/noise-suppression) 0.2.0 (MIT),
каталог `dist/assets/deepfilternet/`.

SHA-256:

```
8ebf2b217b80fc128505b993c8d7d7d892df5a845ab7a2516fed74b76e7fe708  df_bg.wasm
c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616  DeepFilterNet3_onnx.tar.gz
```

Обвязка для вызова — `../dfn.ts`. Имена импортов в ней привязаны к этой сборке `df_bg.wasm`:
при замене файла их нужно сверить.
