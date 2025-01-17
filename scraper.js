const { chromium } = require('playwright')
const fs = require('fs').promises
const csvWriter = require('csv-writer').createObjectCsvWriter

async function scrapeOSCE() {
  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext()
  const page = await context.newPage()

  // Configurar CSV writer con todas las columnas
  const writer = csvWriter({
    path: 'osce_results.csv',
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
    append: true,
  })

  let currentPage = 1
  const baseUrl =
    'https://contratacionesabiertas.osce.gob.pe/entidades?order_last_process=desc'
  let totalRegistros = 0

  try {
    // Crear archivo CSV con headers
    await fs.writeFile('osce_results.csv', '')

    while (true) {
      console.log(`Procesando página ${currentPage}...`)

      // Navegar a la página de listado
      await page.goto(`${baseUrl}&page=${currentPage}`)
      await page.waitForLoadState('networkidle')

      // Cerrar el modal si aparece
      try {
        // Esperar un poco para que aparezca el modal si existe
        await page.waitForSelector('button.shepherd-cancel-icon', {
          timeout: 5000,
        })
        await page.click('button.shepherd-cancel-icon')
        console.log('Modal cerrado exitosamente')
      } catch (error) {
        console.log('No se encontró modal o ya estaba cerrado')
      }

      // Obtener datos de la tabla
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

      if (entidades.length === 0) break

      // Procesar cada entidad
      for (const entidad of entidades) {
        try {
          await page.goto(entidad.url)
          await page.waitForLoadState('networkidle')

          // Cerrar el modal en la página de detalles si aparece
          try {
            await page.waitForSelector('button.shepherd-cancel-icon', {
              timeout: 5000,
            })
            await page.click('button.shepherd-cancel-icon')
          } catch (error) {
            // Ignorar si no hay modal
          }

          // Extraer ubicación y teléfono del perfil
          const detallesEntidad = await page.evaluate(() => {
            const infoCards = document.querySelectorAll('.card-body')
            let ubicacion = ''
            let telefono = ''

            infoCards.forEach((card) => {
              const text = card.textContent
              if (text.includes('Ubicación')) {
                ubicacion = card.querySelector('p')?.textContent.trim() || ''
              }
              if (text.includes('Teléfono')) {
                telefono = card.querySelector('p')?.textContent.trim() || ''
              }
            })

            return { ubicacion, telefono }
          })

          // Preparar registro completo para CSV
          const record = {
            ...entidad,
            ubicacion: detallesEntidad.ubicacion,
            telefono: detallesEntidad.telefono,
          }

          // Escribir al CSV
          await writer.writeRecords([record])

          totalRegistros++
          console.log(`Procesada entidad ${totalRegistros}: ${entidad.entidad}`)
        } catch (error) {
          console.error(`Error procesando entidad ${entidad.url}:`, error)
          await writer.writeRecords([
            {
              ...entidad,
              ubicacion: 'ERROR',
              telefono: 'ERROR',
            },
          ])
        }

        await page.waitForTimeout(1000)
      }

      console.log(
        `Página ${currentPage} completada. Total registros: ${totalRegistros}`
      )
      currentPage++
    }

    console.log('Scraping completado. Total de entidades:', totalRegistros)
  } catch (error) {
    console.error('Error general:', error)
  } finally {
    await browser.close()
  }
}

scrapeOSCE()
