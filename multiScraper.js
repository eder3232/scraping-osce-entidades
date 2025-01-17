const { chromium } = require('playwright')
const fs = require('fs').promises
const csvWriter = require('csv-writer').createObjectCsvWriter

// Configuración para prueba
const TEST_MODE = false
const TOTAL_PAGES_TEST = 2 // Solo procesará 2 páginas
const NUM_WORKERS = 8 // Reducimos workers para la prueba
const PAGE_TIMEOUT = 45000
const NAVIGATION_TIMEOUT = 45000
const MAX_RETRIES = 3
const RETRY_DELAY = 5000

async function processUrlWithRetry(page, url, entidad, workerId) {
  let lastError

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`Worker ${workerId}: Procesando ${url} (Intento ${attempt})`)

      await page.goto(url, { timeout: NAVIGATION_TIMEOUT })
      await page.waitForLoadState('networkidle', { timeout: PAGE_TIMEOUT })

      try {
        await page.waitForSelector('button.shepherd-cancel-icon', {
          timeout: 5000,
        })
        await page.click('button.shepherd-cancel-icon')
      } catch (error) {}

      await page.waitForSelector('.infoTextContainer', {
        timeout: PAGE_TIMEOUT,
      })

      const detallesEntidad = await page.evaluate(() => {
        const getSpansText = (container) => {
          if (!container) return ''
          const spans = container.querySelectorAll('span')
          return Array.from(spans)
            .map((span) => span.textContent.trim())
            .filter((text) => text)
            .join(' ')
        }

        const infoContainers = document.querySelectorAll('.infoTextContainer')
        let ubicacion = ''
        let telefono = ''

        infoContainers.forEach((container) => {
          const text = container.textContent
          if (text.includes('PERU')) {
            ubicacion = getSpansText(container)
          }
          if (text.match(/\d+/)) {
            const phoneSpan = container.querySelector('span')
            if (phoneSpan && phoneSpan.textContent.match(/\d+/)) {
              telefono = phoneSpan.textContent.trim()
            }
          }
        })

        return {
          ubicacion: ubicacion || 'NO DISPONIBLE',
          telefono: telefono || 'NO DISPONIBLE',
        }
      })

      // Log detallado de los datos encontrados
      console.log(`Worker ${workerId}: Datos encontrados:`, {
        entidad: entidad.entidad,
        ubicacion: detallesEntidad.ubicacion,
        telefono: detallesEntidad.telefono,
      })

      return {
        ...entidad,
        ubicacion: detallesEntidad.ubicacion,
        telefono: detallesEntidad.telefono,
      }
    } catch (error) {
      lastError = error
      console.error(
        `Worker ${workerId}: Intento ${attempt} fallido para ${url}: ${error.message}`
      )

      if (attempt < MAX_RETRIES) {
        console.log(
          `Worker ${workerId}: Esperando ${
            RETRY_DELAY / 1000
          }s antes del reintento...`
        )
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY))
      }
    }
  }

  throw lastError
}

async function processUrlBatch(startPage, endPage, workerId) {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  page.setDefaultTimeout(PAGE_TIMEOUT)
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT)

  const results = []

  try {
    for (let currentPage = startPage; currentPage <= endPage; currentPage++) {
      console.log(`\nWorker ${workerId}: Procesando página ${currentPage}`)

      try {
        await page.goto(
          `https://contratacionesabiertas.osce.gob.pe/entidades?order_last_process=desc&page=${currentPage}`
        )
        await page.waitForLoadState('networkidle')

        try {
          await page.waitForSelector('button.shepherd-cancel-icon', {
            timeout: 5000,
          })
          await page.click('button.shepherd-cancel-icon')
        } catch (error) {}

        const entidades = await page.evaluate(() => {
          const rows = document.querySelectorAll('table tr')
          return Array.from(rows)
            .map((row) => {
              const cells = row.querySelectorAll('td')
              const link = row.querySelector('a[href*="/entidad/"]')
              return {
                url: link?.href || '',
                entidad: cells[0]?.textContent.trim() || '',
                ruc: cells[1]?.textContent.trim() || '',
                procesos: cells[2]?.textContent.trim() || '',
                montoContratado: cells[3]?.textContent.trim() || '',
                ultimoProceso: cells[4]?.textContent.trim() || '',
              }
            })
            .filter((entity) => entity.url)
        })

        console.log(
          `Worker ${workerId}: Encontradas ${entidades.length} entidades en página ${currentPage}`
        )

        for (const entidad of entidades) {
          try {
            const result = await processUrlWithRetry(
              page,
              entidad.url,
              entidad,
              workerId
            )
            results.push(result)
          } catch (error) {
            console.error(
              `Worker ${workerId}: Error final en entidad ${entidad.url}:`,
              error.message
            )
            results.push({
              ...entidad,
              ubicacion: 'ERROR',
              telefono: 'ERROR',
            })
          }

          await page.waitForTimeout(1000) // Aumentamos el delay para la prueba
        }
      } catch (error) {
        console.error(
          `Worker ${workerId}: Error en página ${currentPage}:`,
          error.message
        )
        continue
      }
    }
  } finally {
    await browser.close()
  }

  return results
}

async function main() {
  const TOTAL_PAGES = TEST_MODE ? TOTAL_PAGES_TEST : Math.ceil(3292 / 10)
  const PAGES_PER_WORKER = Math.ceil(TOTAL_PAGES / NUM_WORKERS)

  console.log(`\nINICIANDO PRUEBA DE SCRAPING`)
  console.log(`Modo: ${TEST_MODE ? 'PRUEBA' : 'COMPLETO'}`)
  console.log(`Páginas a procesar: ${TOTAL_PAGES}`)
  console.log(`Workers: ${NUM_WORKERS}`)
  console.log(`Páginas por worker: ${PAGES_PER_WORKER}\n`)

  const writer = csvWriter({
    path: 'osce_results_test.csv',
    header: [
      { id: 'entidad', title: 'Entidad' },
      { id: 'ruc', title: 'RUC' },
      { id: 'procesos', title: 'Procesos' },
      { id: 'montoContratado', title: 'Monto Contratado' },
      { id: 'ultimoProceso', title: 'Último Proceso' },
      { id: 'ubicacion', title: 'Ubicación' },
      { id: 'telefono', title: 'Teléfono' },
      { id: 'url', title: 'URL' },
    ],
  })

  await fs.writeFile('osce_results_test.csv', '')

  const workerPromises = []

  for (let i = 0; i < NUM_WORKERS; i++) {
    const startPage = i * PAGES_PER_WORKER + 1
    const endPage = Math.min((i + 1) * PAGES_PER_WORKER, TOTAL_PAGES)

    const workerPromise = processUrlBatch(startPage, endPage, i + 1).then(
      async (results) => {
        console.log(
          `\nWorker ${i + 1} completó su batch. Escribiendo ${
            results.length
          } registros...`
        )
        await writer.writeRecords(results)
        return results.length
      }
    )

    workerPromises.push(workerPromise)
  }

  const results = await Promise.all(workerPromises)
  const totalRegistros = results.reduce((a, b) => a + b, 0)

  console.log('\nPRUEBA COMPLETADA')
  console.log(`Total de registros procesados: ${totalRegistros}`)
}

main().catch(console.error)
