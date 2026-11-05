/**
 * Обвязка DeepFilterNet3 (libDF, собран wasm-bindgen): создание состояния и обработка кадра.
 * Только то, что нужно шумодаву; работает и в воркере, и в Node (для проверок).
 *
 * Имена импортов с хешами привязаны к конкретной сборке dfn/df_bg.wasm — при замене файла
 * их нужно сверить (WebAssembly.Module.imports). Происхождение файлов: dfn/NOTICE.md.
 */

interface DfExports {
  memory: WebAssembly.Memory
  df_create(modelPtr: number, modelLen: number, attenLimDb: number): number
  df_get_frame_length(state: number): number
  /** Возвращает Float32Array (externref), созданный импортом new_from_slice. */
  df_process_frame(state: number, inputPtr: number, inputLen: number): Float32Array
  df_set_atten_lim(state: number, limDb: number): void
  __wbg_dfstate_free(state: number, flag: number): void
  __wbindgen_malloc_command_export(size: number, align: number): number
  __wbindgen_exn_store_command_export(index: number): void
  __externref_table_alloc_command_export(): number
  __wbindgen_externrefs: WebAssembly.Table
  __wbindgen_start(): void
}

export interface DeepFilter {
  /** Размер кадра в сэмплах (480 = 10 мс при 48 кГц). */
  readonly frameLength: number
  /** Очищает один кадр (значения −1…1). Результат задержан на 30 мс относительно входа. */
  process(frame: Float32Array): Float32Array
  destroy(): void
}

/**
 * @param module скомпилированный df_bg.wasm
 * @param model  DeepFilterNet3_onnx.tar.gz как есть (gzip)
 * @param attenuationLimitDb предел подавления шума, дБ (100 — без ограничения)
 */
export async function createDeepFilter(module: WebAssembly.Module, model: Uint8Array, attenuationLimitDb = 100): Promise<DeepFilter> {
  let wasm!: DfExports
  let u8: Uint8Array | null = null
  let f32: Float32Array | null = null
  // Память wasm может вырасти — тогда старые представления отсоединяются (byteLength = 0).
  const bytes = (): Uint8Array => (u8 && u8.byteLength > 0 ? u8 : (u8 = new Uint8Array(wasm.memory.buffer)))
  const floats = (): Float32Array => (f32 && f32.byteLength > 0 ? f32 : (f32 = new Float32Array(wasm.memory.buffer)))
  const decoder = new TextDecoder()

  const imports = {
    './df_bg.js': {
      __wbg_new_from_slice_b6858b485924da4e: (ptr: number, len: number): Float32Array => {
        const start = (ptr >>> 0) / 4
        return floats().slice(start, start + len)
      },
      __wbg_getRandomValues_cc7f052a444bb2ce: (ptr: number, len: number): void => {
        try {
          const view = bytes().subarray(ptr >>> 0, (ptr >>> 0) + len)
          // getRandomValues не принимает представления SharedArrayBuffer и больше 64 КБ — заполняем через копию.
          for (let off = 0; off < view.length; off += 65536) {
            const chunk = new Uint8Array(Math.min(65536, view.length - off))
            globalThis.crypto.getRandomValues(chunk)
            view.set(chunk, off)
          }
        } catch (err) {
          const index = wasm.__externref_table_alloc_command_export()
          wasm.__wbindgen_externrefs.set(index, err)
          wasm.__wbindgen_exn_store_command_export(index)
        }
      },
      __wbg___wbindgen_throw_6b64449b9b9ed33c: (ptr: number, len: number): never => {
        throw new Error(decoder.decode(bytes().slice(ptr >>> 0, (ptr >>> 0) + len)))
      },
      __wbindgen_init_externref_table: (): void => {
        const table = wasm.__wbindgen_externrefs
        const offset = table.grow(4)
        table.set(0, undefined)
        table.set(offset + 0, undefined)
        table.set(offset + 1, null)
        table.set(offset + 2, true)
        table.set(offset + 3, false)
      }
    }
  }

  const instance = await WebAssembly.instantiate(module, imports)
  wasm = instance.exports as unknown as DfExports
  wasm.__wbindgen_start()

  // Аргументы-срезы wasm-bindgen: память выделяем мы, освобождает вызываемая функция.
  const modelPtr = wasm.__wbindgen_malloc_command_export(model.length, 1) >>> 0
  bytes().set(model, modelPtr)
  let state = wasm.df_create(modelPtr, model.length, attenuationLimitDb) >>> 0
  const frameLength = wasm.df_get_frame_length(state) >>> 0

  return {
    frameLength,
    process(frame: Float32Array): Float32Array {
      if (frame.length !== frameLength) throw new Error(`DeepFilterNet: нужен кадр из ${frameLength} сэмплов, получено ${frame.length}`)
      const ptr = wasm.__wbindgen_malloc_command_export(frameLength * 4, 4) >>> 0
      floats().set(frame, ptr / 4)
      return wasm.df_process_frame(state, ptr, frameLength)
    },
    destroy(): void {
      if (!state) return
      wasm.__wbg_dfstate_free(state, 0)
      state = 0
    }
  }
}
