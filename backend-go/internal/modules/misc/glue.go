package misc

import (
	"sort"

	"github.com/jackc/pgx/v5"

	"cmk-avrora-erp/backend-go/internal/models"
	"cmk-avrora-erp/backend-go/internal/modules/catalog"
)

const catalogMaterialCols = catalog.MaterialCols

func catalogScanMaterial(row pgx.Row) (models.Material, error) { return catalog.ScanMaterial(row) }

func sortSliceStable[T any](s []T, less func(i, j int) bool) { sort.SliceStable(s, less) }
