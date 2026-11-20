import { describe, expect, it } from 'vitest';
import { sortItem, sortStateOf, type SortContext } from './itemSort';

const model: SortContext = {
  model: true,
  itemMeshes: ['HatBack', 'HatFront'],
  mainMeshes: ['ArtMeshBody', 'ArtMeshMouth'],
  side: 'front',
};
const image: SortContext = { ...model, model: false, itemMeshes: ['ImageMesh'] };

describe('ItemSortRequest', () => {
  it('puts an item just in front of an art mesh, and answers whether the model has it', () => {
    const r = sortItem(
      { frontOn: true, setFrontOrder: 'UseArtMeshID', withinModelOrderFront: 'ArtMeshBody' },
      {},
      model,
    );
    expect(r).toMatchObject({
      layer: { above: 'ArtMeshBody' },
      split: null,
      loadedModelHadRequestedFrontLayer: true,
      loadedModelHadRequestedBackLayer: false,
    });
    // Another model's art mesh is kept, and drawn on the item's side until a model has it.
    const other = sortItem(
      { frontOn: true, setFrontOrder: 'UseArtMeshID', withinModelOrderFront: 'Elsewhere' },
      {},
      model,
    );
    expect(other).toMatchObject({
      state: { front: { above: 'Elsewhere' } },
      layer: { above: 'Elsewhere' },
      loadedModelHadRequestedFrontLayer: false,
    });
  });

  it('puts an item fully in front or behind, and leaves it on its side when not inserted', () => {
    const behind = sortItem(
      { frontOn: true, setFrontOrder: 'UseSpecialID', withinModelOrderFront: 'FullyInBack' },
      {},
      model,
    );
    expect(behind).toMatchObject({ layer: 'behind', loadedModelHadRequestedFrontLayer: true });
    // Off: drawn on its side; the order is kept for later.
    const off = sortItem(
      { frontOn: false, setFrontOrder: 'UseArtMeshID', withinModelOrderFront: 'ArtMeshMouth' },
      {},
      { ...model, side: 'behind' },
    );
    expect(off).toMatchObject({ layer: 'behind', state: { front: { above: 'ArtMeshMouth' } } });
    // On again with the order unchanged: inserted where it was asked; nothing was requested now.
    const on = sortItem({ frontOn: true }, (off as { state: object }).state, model);
    expect(on).toMatchObject({
      layer: { above: 'ArtMeshMouth' },
      loadedModelHadRequestedFrontLayer: false,
    });
  });

  it('splits a model item into a front and a back part', () => {
    const r = sortItem(
      {
        frontOn: true,
        backOn: true,
        setSplitPoint: 'UseArtMeshID',
        splitAt: 'HatFront',
        setFrontOrder: 'UseArtMeshID',
        withinModelOrderFront: 'ArtMeshMouth',
        setBackOrder: 'UseArtMeshID',
        withinModelOrderBack: 'ArtMeshBody',
      },
      {},
      model,
    );
    expect(r).toMatchObject({
      layer: { above: 'ArtMeshMouth' },
      split: { mesh: 'HatFront', back: { above: 'ArtMeshBody' } },
      loadedModelHadRequestedFrontLayer: true,
      loadedModelHadRequestedBackLayer: true,
    });
    const state = (r as { state: object }).state;
    // The back part off: drawn whole; on again, fully behind.
    expect(sortItem({ frontOn: true, backOn: false }, state, model)).toMatchObject({ split: null });
    expect(
      sortItem(
        {
          frontOn: true,
          backOn: true,
          setBackOrder: 'UseSpecialID',
          withinModelOrderBack: 'FullyInBack',
        },
        state,
        model,
      ),
    ).toMatchObject({ split: { mesh: 'HatFront', back: 'behind' } });
    // A back part without a split point: drawn whole.
    expect(
      sortItem({ frontOn: true, backOn: true, setSplitPoint: 'UseSpecialID' }, state, model),
    ).toMatchObject({ split: null, state: { back: { above: 'ArtMeshBody' } } });
    // Rebuilt from the item layout after a reload.
    expect(
      sortStateOf({ above: 'ArtMeshMouth' }, { mesh: 'HatFront', back: { above: 'ArtMeshBody' } }),
    ).toEqual({
      front: { above: 'ArtMeshMouth' },
      back: { above: 'ArtMeshBody' },
      splitAt: 'HatFront',
    });
  });

  it('ignores the back part and the split point of image items', () => {
    const r = sortItem(
      {
        frontOn: true,
        backOn: true,
        setFrontOrder: 'UseArtMeshID',
        withinModelOrderFront: 'ArtMeshBody',
        setSplitPoint: 'nonsense',
        setBackOrder: 'UseArtMeshID',
        withinModelOrderBack: 5,
      },
      {},
      image,
    );
    expect(r).toMatchObject({
      layer: { above: 'ArtMeshBody' },
      split: null,
      state: { front: { above: 'ArtMeshBody' } },
      loadedModelHadRequestedBackLayer: false,
    });
  });

  it('refuses invalid requests with the protocol’s errors', () => {
    const err = (d: Record<string, unknown>) =>
      (sortItem(d, {}, model) as { errorID?: number }).errorID;
    expect(err({ setFrontOrder: 'Sideways' })).toBe(1251);
    expect(err({ setFrontOrder: 'UseSpecialID', withinModelOrderFront: 'Middle' })).toBe(1252);
    expect(err({ setFrontOrder: 'UseArtMeshID', withinModelOrderFront: '' })).toBe(1252);
    // The back part cannot go fully in front.
    expect(err({ setBackOrder: 'UseSpecialID', withinModelOrderBack: 'FullyInFront' })).toBe(1253);
    expect(err({ setSplitPoint: 'UseArtMeshID', splitAt: 'NotInTheItem' })).toBe(1254);
    expect(err({})).toBeUndefined();
  });
});
