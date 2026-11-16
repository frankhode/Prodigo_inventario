// Proyección de imágenes incorporadas a un lote, pero todavía sin número individual.
// Los números del rango se reservan en PostgreSQL; nunca inferimos correspondencias.
export function unlinkedBulkEntries(batchesWithDetails) {
  const rows=[];
  for(const {batch,details} of batchesWithDetails) {
    if(!batch||!details)continue;
    const linked=new Set((details.slots||[]).map(slot=>slot.image_id).filter(Boolean));
    for(const image of details.images||[]) {
      if(linked.has(image.id))continue;
      const shared=batch.common_values||{}, own=image.image_values||{};
      rows.push({
        id:image.id,
        isBulkUnlinked:true,
        bulkBatchId:batch.id,
        bulkRange:{start:batch.start_number,end:batch.end_number},
        code:null,
        number:null,
        category:own.category||shared.category||'Fotografía',
        destination:own.destination||shared.destination||'museo',
        brand:own.brand||shared.brand||'',
        model:own.model||shared.model||'',
        manufacture_date:own.manufacture_date||shared.manufacture_date||'',
        original_number:own.original_number||shared.original_number||'',
        type:own.type||shared.type||'',
        notes:own.notes||shared.notes||'',
        photo_path:image.photo_path,
        extra_photos:image.extra_photos||[],
        catalog_source:image.source_data||{},
        original_filename:image.original_filename,
        created_at:batch.created_at
      });
    }
  }
  return rows;
}
