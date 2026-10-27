---
name: registro-contratos
description: Conocimiento del proceso de registro de contratos vigentes de Periferia IT Group. Incluye el esquema del maestro, las reglas de negocio RN1–RN7, los parámetros, los casos especiales y la interpretación de alertas. Úsalo para clasificar, validar y registrar contratos recibidos en el buzón único.
---

# Proceso: Registro de Contratos Vigentes

## Contexto
- El maestro de contratos estuvo **congelado desde el 2026-05-30**, porque se dejó de alimentar cuando salió la persona responsable.
- Antes solo llegaban a administración los contratos **con póliza**. Ahora **todo contrato** debe registrarse, tenga póliza o no.
- No hay área legal interna. El agente **no** revisa cláusulas jurídicas: solo registra datos y alerta riesgos.

## Parámetros
| Parámetro | Valor |
|---|---|
| Umbral de confianza para revisión humana | 0.8 (campos con confianza < 0.8) |
| Ventana de alerta de vencimiento | 60 días |
| Fecha de corte del maestro | 2026-05-30 |
| Similitud mínima de objeto para considerar el mismo contrato | 0.9 (Dice de bigramas) |
| Monedas válidas | COP, USD, PEN, PAB, HNL |
| Países válidos | CO, EC, PE, PA, HN |

## Esquema del maestro (una fila por contrato)
`id_contrato, cliente, nit_cliente, pais, objeto, valor, moneda, fecha_inicio, fecha_fin, requiere_poliza, tipo_poliza, estado_poliza, comercial, ruta_sharepoint, fecha_registro, fuente`

- **id_contrato:** el número tal como aparece en el documento. Si no tiene, se asigna `AUTO-<año>-<secuencia>`.
- **nit_cliente:** sin dígito de verificación ni puntos.
- **valor:** sin separadores. Es `0` si el contrato es por demanda (`valor_indeterminado`).
- **fecha_fin:** si el contrato da el plazo en meses, se calcula como inicio + N meses − 1 día.
- **estado_poliza:** un contrato nuevo con póliza queda `pendiente`; uno sin póliza queda `no_aplica`.
- **comercial:** el nombre que corresponde al remitente en `comerciales.json`.

## Reglas de negocio
- **RN1 Duplicado:** mismo `id_contrato` y mismos `valor`, `fecha_inicio` y `fecha_fin`. No se escribe nada; solo se reporta.
- **RN2 Actualización:** mismo `id_contrato`, o mismo `nit_cliente` con un objeto de similitud ≥ 0.9, y algún campo distinto. También cuando el documento es un otrosí. Se actualiza la fila y se deja el cambio en `historial.jsonl`.
  - Si es un **otrosí**, sus cambios son esperados y no se consideran conflicto.
  - Si es el **mismo contrato con datos distintos y no hay otrosí**, cada diferencia es un `conflicto:<campo>` y requiere revisión humana.
  - Si el otrosí ordena **ampliar las garantías**, `estado_poliza` pasa a `pendiente`.
- **RN3 Nuevo:** no hay coincidencia con el maestro. Se inserta la fila.
- **RN4 Rechazado:** el correo no trae adjunto de contrato (por ejemplo, una cotización), el texto no permite identificar partes ni objeto, o es un otrosí de un contrato que no existe en el maestro.
- **RN5 Revisión humana:** todo campo con confianza < 0.8 o con conflicto exige confirmación explícita (`confirmado = true`).
- **RN6:** el fixture del maestro es de solo lectura. Se trabaja sobre la copia `out/sharepoint/maestro-contratos.csv`.
- **RN7:** cada ejecución de herramienta deja una línea en `out/log.jsonl`.

## Casos especiales
- **Contrato marco o por demanda:** valor 0, `valor_indeterminado = true` y confianza 0.5 en el valor, así que **requiere confirmación**.
- **Plazo en meses contado desde la firma:** si el documento solo da el mes de firma, se asume el día 1 (confianza 0.8). La fecha de fin derivada, sobre todo si hay prórroga automática, tiene confianza 0.5 y **requiere confirmación**.
- **Póliza condicional** (por ejemplo, "para órdenes de servicio mayores a…"): se registra `requiere_poliza = true` con un aviso.
- **Remitente no registrado:** se reporta, pero **no bloquea** el registro. El comercial queda como `NO REGISTRADO (<correo>)`.
- **Reenvíos ("RV:")** de contratos que ya existen: casi siempre son duplicados.

## Archivo (simulación de SharePoint)
- Contratos: `out/sharepoint/Contratos/<año_inicio>/<cliente-slug>/<id_contrato>.<ext>`.
- Otrosíes: `<id_contrato>_otrosi-<n>.<ext>`, en la misma carpeta del contrato.

## Lectura de alertas
1. **Vencen en ≤ 60 días:** hay que gestionar la renovación o el cierre con el comercial.
2. **Pólizas requeridas no vigentes:** hay que gestionarlas con el corredor. Es el riesgo más alto.
3. **Registrados o actualizados desde el corte:** evidencia del gap que se va cubriendo.
4. **Vencidos que siguen en el maestro:** hay que confirmar si se liquidaron y, si es así, darlos de baja.
